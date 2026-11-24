import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { resolve } from "node:path";

export default defineConfig({
  root: "src/web",
  publicDir: resolve(import.meta.dirname, "public"),
  plugins: [preact()],
  build: {
    outDir: resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        upload: resolve(import.meta.dirname, "src/web/index.html"),
        admin: resolve(import.meta.dirname, "src/web/admin/index.html"),
        privasi: resolve(import.meta.dirname, "src/web/privasi/index.html"),
      },
    },
  },
});
