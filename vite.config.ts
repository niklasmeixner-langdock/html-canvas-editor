import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    sourcemap: process.env.NODE_ENV === "development" ? "inline" : false,
    cssMinify: process.env.NODE_ENV !== "development",
    minify: process.env.NODE_ENV !== "development",
    rollupOptions: {
      input: path.join(root, "mcp-app.html"),
    },
    outDir: "dist",
    emptyOutDir: true,
  },
});
