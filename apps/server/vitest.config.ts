import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@dibao/ranking": fileURLToPath(new URL("../../packages/ranking/src/index.ts", import.meta.url)),
      "@dibao/db": fileURLToPath(new URL("../../packages/db/src/index.ts", import.meta.url)),
      "@dibao/rss": fileURLToPath(new URL("../../packages/rss/src/index.ts", import.meta.url)),
      "@dibao/plugin-sdk": fileURLToPath(
        new URL("../../packages/plugin-sdk/src/index.ts", import.meta.url)
      ),
      "@dibao/shared": fileURLToPath(
        new URL("../../packages/shared/src/index.ts", import.meta.url)
      )
    }
  }
});
