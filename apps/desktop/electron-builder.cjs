const prerelease = require("./package.json").version.includes("-");
module.exports = {
  appId: "com.dibao.desktop",
  productName: "Dibao",
  copyright: "Copyright Dibao contributors",
  asar: true,
  npmRebuild: false,
  electronDist: process.env.DIBAO_ELECTRON_DIST,
  directories: { output: "../../dist/desktop" },
  files: ["dist/**/*", "package.json", "!dist/**/*.test.*", "!dist/**/*.map", "!dist/**/*.d.ts", "!dist/.tsbuildinfo"],
  extraResources: [
    { from: process.env.DIBAO_DESKTOP_PAYLOAD, to: "dibao", filter: ["**/*", "!.npm-cache/**/*"] },
    { from: `${process.env.DIBAO_DESKTOP_PAYLOAD}/node_modules`, to: "dibao/node_modules", filter: ["**/*", "!.bin/**/*", "!.package-lock.json"] }
  ],
  artifactName: "Dibao-${version}-${os}-${arch}.${ext}",
  publish: [{ provider: "github", owner: "Pls-1q43", repo: "Dibao", releaseType: prerelease ? "prerelease" : "release", channel: prerelease ? "beta" : "latest" }],
  win: { target: ["nsis"], icon: "../web/public/logo-1024.png", signExecutable: false },
  nsis: { oneClick: true, perMachine: false, deleteAppDataOnUninstall: false, runAfterFinish: true },
  mac: { target: ["dmg", "zip"], icon: "../web/public/logo-1024.png", category: "public.app-category.news", identity: null },
  dmg: { sign: false },
  linux: { target: ["dir"], category: "News" }
};
