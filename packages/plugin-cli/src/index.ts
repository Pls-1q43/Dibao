#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import {
  signPluginPackage,
  validatePluginPackage,
  type DibaoPluginPackage
} from "@dibao/plugin-sdk";

type CommandOptions = Record<string, string | true>;

async function main(argv: string[]): Promise<void> {
  const [command = "help", target = ".", ...rest] = argv;
  const options = parseOptions(rest);
  if (command === "create") {
    createPlugin(target);
    return;
  }
  if (command === "validate") {
    validatePackage(target);
    return;
  }
  if (command === "pack") {
    packPlugin(target, stringOption(options.out) ?? `${basename(target)}.dibao-plugin`);
    return;
  }
  if (command === "sign") {
    signPackage(target, {
      privateKey: requiredStringOption(options.privateKey, "--private-key is required"),
      publicKey: stringOption(options.publicKey),
      keyId: stringOption(options.keyId),
      out: stringOption(options.out) ?? target
    });
    return;
  }
  if (command === "dev") {
    console.log("dibao-plugin dev: validate the package during local development.");
    validatePackage(target);
    return;
  }
  printHelp();
}

function createPlugin(targetDir: string): void {
  mkdirSync(join(targetDir, "server"), { recursive: true });
  mkdirSync(join(targetDir, "web"), { recursive: true });
  mkdirSync(join(targetDir, "locales"), { recursive: true });
  mkdirSync(join(targetDir, "migrations"), { recursive: true });
  mkdirSync(join(targetDir, "tests"), { recursive: true });
  mkdirSync(join(targetDir, "scripts"), { recursive: true });
  const id = `dev.example.${basename(targetDir).replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  writeFileSync(
    join(targetDir, "plugin.json"),
    `${JSON.stringify(
      {
        manifestVersion: 1,
        id,
        name: basename(targetDir),
        version: "0.1.0",
        publisher: "Example",
        dibao: { minVersion: "0.2.0", maxVersion: "<0.4.0" },
        entry: { server: "server/index.mjs", web: "web/index.html" },
        capabilities: ["settings:plugin", "files:plugin-data", "jobs:write"],
        contributes: {
          actions: [],
          routes: [],
          settingsTabs: [
            {
              id: "settings",
              title: "Example Plugin",
              slot: "settings.tabs",
              route: "settings",
              order: 90,
              icon: "settings"
            }
          ],
          hooks: ["maintenance.tick"],
          tasks: [
            {
              id: "example.refresh",
              kind: "background",
              schedule: "manual",
              defaultEnabled: false
            }
          ]
        }
      },
      null,
      2
    )}\n`
  );
  writeFileSync(join(targetDir, "server/index.mjs"), serverTemplate());
  writeFileSync(join(targetDir, "web/index.html"), webTemplate(id));
  writeFileSync(join(targetDir, "README.md"), readmeTemplate(id));
  writeFileSync(join(targetDir, "RELEASE_CHECKLIST.md"), releaseChecklistTemplate());
  writeFileSync(join(targetDir, "tests/README.md"), testReadmeTemplate());
  writeFileSync(join(targetDir, "scripts/sign.example.sh"), signExampleTemplate());
  writeFileSync(join(targetDir, "locales/zh-CN.json"), `${JSON.stringify({ name: "示例插件", description: "邸报 0.2 插件模板。" }, null, 2)}\n`);
  writeFileSync(join(targetDir, "locales/en-US.json"), `${JSON.stringify({ name: "Example Plugin", description: "Dibao 0.2 plugin template." }, null, 2)}\n`);
  writeFileSync(join(targetDir, "locales/ja-JP.json"), `${JSON.stringify({ name: "サンプルプラグイン", description: "Dibao 0.2 プラグインテンプレート。" }, null, 2)}\n`);
  writeFileSync(join(targetDir, "migrations/README.md"), "Add raw SQL migrations here and list them in plugin.json when your plugin needs durable schema changes. Request the database:plugin capability only when needed.\n");
  console.log(`Created plugin template in ${targetDir}`);
}

function serverTemplate(): string {
  return `export default {
  async activate(ctx) {
    ctx.hooks.on("maintenance.tick", async () => {
      await ctx.storage.set("lastMaintenanceTickAt", await ctx.now());
    });

    ctx.tasks.register("example.refresh", async () => {
      await ctx.storage.set("lastRefreshAt", await ctx.now());
    });

    ctx.api.get("/state", async () => ({
      settings: await ctx.settings.list(),
      lastRefreshAt: await ctx.storage.get("lastRefreshAt"),
      generatedAt: await ctx.now()
    }));

    ctx.api.post("/settings", async ({ body }) => {
      const input = body && typeof body === "object" ? body : {};
      await ctx.settings.set("enabled", input.enabled === true);
      return { settings: await ctx.settings.list() };
    });
  }
};
`;
}

function webTemplate(pluginId: string): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Dibao Plugin</title>
    <link rel="stylesheet" href="/api/plugins/ui.css" />
  </head>
  <body class="dibao-plugin">
    <main class="page">
      <section class="header">
        <div>
          <p class="kicker">Plugin</p>
          <h1>Dibao Plugin</h1>
          <p id="summary">Loading plugin state...</p>
        </div>
      </section>
      <section class="panel">
        <pre id="output" class="code-block"></pre>
      </section>
    </main>
    <script>
      const pluginId = ${JSON.stringify(pluginId)};
      const pending = new Map();

      window.addEventListener("message", (event) => {
        const data = event.data || {};
        if (data.type !== "dibao.bridge.response" || data.pluginId !== pluginId || typeof data.requestId !== "string") return;
        const handler = pending.get(data.requestId);
        if (!handler) return;
        pending.delete(data.requestId);
        data.ok ? handler.resolve(data.result) : handler.reject(new Error(data.error || "Plugin bridge request failed"));
      });

      function bridge(method, payload) {
        const requestId = \`\${Date.now()}:\${Math.random().toString(16).slice(2)}\`;
        return new Promise((resolve, reject) => {
          pending.set(requestId, { resolve, reject });
          window.parent.postMessage({ type: "dibao.bridge", schemaVersion: 1, pluginId, requestId, method, payload }, "*");
          window.setTimeout(() => {
            if (!pending.has(requestId)) return;
            pending.delete(requestId);
            reject(new Error("Host response timed out"));
          }, 10000);
        });
      }

      async function pluginApi(path, body, method = "GET") {
        return await bridge("pluginApi", { path, method, body });
      }

      pluginApi("state")
        .then((state) => {
          document.getElementById("summary").textContent = "Plugin bridge is connected.";
          document.getElementById("output").textContent = JSON.stringify(state, null, 2);
        })
        .catch((error) => {
          document.getElementById("summary").textContent = error.message;
        });
    </script>
  </body>
</html>
`;
}

function readmeTemplate(pluginId: string): string {
  return `# ${pluginId}

This is a Dibao 0.2 plugin template.

## Development

- Edit \`plugin.json\` to declare capabilities, contributions, and optional migrations.
- Implement server code in \`server/index.mjs\`; host APIs are asynchronous JSON-RPC calls.
- Implement web UI in \`web/index.html\`; use the sandboxed iframe bridge instead of direct \`fetch\`.
- Keep third-party code trusted and auditable. Dibao 0.2 isolates plugins in a Node host process, but does not claim hostile-code sandboxing.

## Commands

\`\`\`sh
dibao-plugin validate .
dibao-plugin pack . --out ${pluginId}.dibao-plugin
dibao-plugin sign ${pluginId}.dibao-plugin --private-key private.pem --public-key public.pem --key-id example --out ${pluginId}.signed.dibao-plugin
\`\`\`
`;
}

function releaseChecklistTemplate(): string {
  return `# Release Checklist

- [ ] \`dibao-plugin validate .\` passes.
- [ ] Server handlers only use declared capabilities.
- [ ] Web UI works inside a sandboxed iframe and uses the bridge for host calls.
- [ ] Any migrations are listed in \`plugin.json\` with stable version and checksum.
- [ ] Package is signed with a trusted key and the public key id is documented.
- [ ] README documents install, update, rollback, settings, secrets, and known limitations.
- [ ] Manual smoke test covers install, enable, disable, update, and rollback.
`;
}

function testReadmeTemplate(): string {
  return `# Plugin Tests

Recommended smoke cases:

- Validate manifest and package.
- Enable plugin and confirm server activation succeeds.
- Call each plugin API route through the iframe bridge.
- Disable plugin and confirm queued plugin jobs are cancelled or paused.
- Tamper with a signed package and confirm verification fails.
`;
}

function signExampleTemplate(): string {
  return `#!/usr/bin/env sh
set -eu

dibao-plugin pack . --out plugin.dibao-plugin
dibao-plugin sign plugin.dibao-plugin \\
  --private-key private.pem \\
  --public-key public.pem \\
  --key-id example-key \\
  --out plugin.signed.dibao-plugin
`;
}

function validatePackage(inputPath: string): void {
  const pluginPackage = readPackageOrDirectory(inputPath);
  const result = validatePluginPackage(pluginPackage);
  if (!result.ok) {
    for (const error of result.errors) {
      console.error(error);
    }
    process.exitCode = 1;
    return;
  }
  console.log("Plugin package is valid.");
}

function packPlugin(sourceDir: string, outPath: string): void {
  const pluginPackage = packageFromDirectory(sourceDir);
  const result = validatePluginPackage(pluginPackage);
  if (!result.ok) {
    for (const error of result.errors) {
      console.error(error);
    }
    process.exitCode = 1;
    return;
  }
  writeFileSync(outPath, `${JSON.stringify(pluginPackage, null, 2)}\n`);
  console.log(`Wrote ${outPath}`);
}

function signPackage(inputPath: string, options: {
  privateKey: string;
  publicKey?: string;
  keyId?: string;
  out: string;
}): void {
  const pluginPackage = readPackageOrDirectory(inputPath);
  const signed = signPluginPackage({
    pluginPackage,
    privateKeyPem: readFileSync(options.privateKey, "utf8"),
    publicKeyPem: options.publicKey ? readFileSync(options.publicKey, "utf8") : undefined,
    keyId: options.keyId
  });
  writeFileSync(options.out, `${JSON.stringify(signed, null, 2)}\n`);
  console.log(`Signed ${options.out}`);
}

function readPackageOrDirectory(inputPath: string): DibaoPluginPackage {
  if (statSync(inputPath).isDirectory()) {
    return packageFromDirectory(inputPath);
  }
  return JSON.parse(readFileSync(inputPath, "utf8")) as DibaoPluginPackage;
}

function packageFromDirectory(sourceDir: string): DibaoPluginPackage {
  const manifestPath = join(sourceDir, "plugin.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`plugin.json not found in ${sourceDir}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  const files: Record<string, string> = {};
  for (const file of listFiles(sourceDir)) {
    const rel = relative(sourceDir, file);
    if (rel === "plugin.json" || rel.endsWith(".dibao-plugin")) {
      continue;
    }
    files[rel] = readFileSync(file, "utf8");
  }
  return { manifest, files };
}

function listFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function parseOptions(args: string[]): CommandOptions {
  const options: CommandOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const value = args[index + 1];
    if (value && !value.startsWith("--")) {
      options[key] = value;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}

function stringOption(value: string | true | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requiredStringOption(value: string | true | undefined, message: string): string {
  const option = stringOption(value);
  if (!option) {
    throw new Error(message);
  }
  return option;
}

function printHelp(): void {
  console.log(`dibao-plugin create <dir>
dibao-plugin validate <dir|package>
dibao-plugin pack <dir> --out plugin.dibao-plugin
dibao-plugin sign <dir|package> --private-key key.pem --public-key pub.pem --out signed.dibao-plugin
dibao-plugin dev <dir|package>`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
