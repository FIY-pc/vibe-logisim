import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
// Serve the same offline PDF resources in development and packaged builds.
const pdfRoot = path.dirname(
  createRequire(import.meta.url).resolve("pdfjs-dist/package.json"),
);
const pdfFiles = new Map<string, string>();
for (const directory of ["cmaps", "standard_fonts", "wasm"]) {
  for (const entry of await readdir(path.join(pdfRoot, directory), {
    withFileTypes: true,
  })) {
    if (entry.isFile())
      pdfFiles.set(
        `pdfjs/${directory}/${entry.name}`,
        path.join(pdfRoot, directory, entry.name),
      );
  }
}
export default defineConfig({
  plugins: [
    react(),
    {
      name: "offline-pdf-resources",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const file = pdfFiles.get((req.url || "").split("?")[0].slice(1));
          if (!file) return next();
          readFile(file)
            .then((bytes) => {
              res.setHeader(
                "Content-Type",
                file.endsWith(".wasm")
                  ? "application/wasm"
                  : "application/octet-stream",
              );
              res.end(bytes);
            })
            .catch(next);
        });
      },
      async generateBundle() {
        for (const [fileName, file] of pdfFiles)
          this.emitFile({
            type: "asset",
            fileName,
            source: await readFile(file),
          });
      },
    },
  ],
  server: { proxy: { "/api": "http://127.0.0.1:8793" } },
  clearScreen: false,
});
