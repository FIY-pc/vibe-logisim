import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pdfViewerFiles } from "../../scripts/workbench/pdf-viewer.mts";
// Serve the same offline PDF resources in development and packaged builds.
const pdfRoot = path.dirname(
  createRequire(import.meta.url).resolve("pdfjs-dist/package.json"),
);
const pdfFiles = new Map<string, string>();
for (const [name, file] of await pdfViewerFiles(
  path.resolve(import.meta.dirname, "../.."),
))
  pdfFiles.set(name, file);
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
  // Lazy readers must not trigger a dependency reload halfway through adding a reference.
  optimizeDeps: {
    include: [
      "pptx-react-viewer",
      "pptx-react-viewer/i18n/zh-CN",
      "ooxml-core/pptx",
      "ooxml-ui/pptx",
    ],
  },
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
                (
                  {
                    ".wasm": "application/wasm",
                    ".html": "text/html; charset=utf-8",
                    ".mjs": "text/javascript",
                    ".css": "text/css",
                    ".json": "application/json",
                    ".svg": "image/svg+xml",
                    ".png": "image/png",
                    ".ftl": "text/plain; charset=utf-8",
                  } as Record<string, string>
                )[path.extname(file)] || "application/octet-stream",
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
  // Follow the host's port so several previews can run side by side.
  server: {
    proxy: {
      "/api": `http://127.0.0.1:${process.env.VIBE_WORKBENCH_PORT || "8793"}`,
    },
  },
  clearScreen: false,
});
