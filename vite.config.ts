import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [{ find: /^@chimera\//, replacement: fileURLToPath(new URL("./chimera/src/", import.meta.url)) }],
  },
  publicDir: "chimera/public",
  assetsInclude: ["**/*.wasm"],
  worker: { format: "es" },
  build: { target: "es2022", sourcemap: true },
  server: { host: "127.0.0.1", port: 5417, strictPort: true },
  preview: { host: "127.0.0.1", port: 5418, strictPort: true },
});
