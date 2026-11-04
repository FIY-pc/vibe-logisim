/** Mozilla's complete viewer, pinned like the other bundled runtimes. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";

export async function pdfViewerFiles(
  root: string,
): Promise<Map<string, string>> {
  const spec = JSON.parse(
    await readFile(path.join(root, "config/pdf-viewer.json"), "utf8"),
  );
  const base = path.join(root, ".workbench-cache/pdf-viewer", spec.version);
  const marker = path.join(base, ".sha256");
  if ((await readFile(marker, "utf8").catch(() => "")) !== spec.sha256) {
    const archive = path.join(
      root,
      ".workbench-cache/downloads",
      `pdfjs-${spec.version}-dist.zip`,
    );
    let bytes = await readFile(archive).catch(() => null);
    const digest = (value: Uint8Array) =>
      createHash("sha256").update(value).digest("hex");
    if (!bytes || digest(bytes) !== spec.sha256) {
      console.log(`Downloading PDF.js viewer ${spec.version}`);
      const response = await fetch(spec.url, {
        signal: AbortSignal.timeout(300000),
      });
      if (!response.ok)
        throw new Error(`PDF viewer download: HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
      if (digest(bytes) !== spec.sha256)
        throw new Error("PDF viewer checksum mismatch");
      await mkdir(path.dirname(archive), { recursive: true });
      await writeFile(archive, bytes);
    }
    for (const [name, data] of Object.entries(unzipSync(bytes))) {
      if (name.endsWith("/") || name.endsWith(".map") || name.endsWith(".pdf"))
        continue;
      if (name !== "LICENSE" && !/^(web|build)\//.test(name)) continue;
      if (name.split("/").some((part) => part === ".."))
        throw new Error("Invalid viewer archive path");
      const file = path.join(base, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(
        file,
        name === "web/viewer.html"
          ? Buffer.from(
              Buffer.from(data)
                .toString("utf8")
                .replace(
                  '<script src="viewer.mjs" type="module"></script>',
                  '<link rel="stylesheet" href="workbench.css" /><script src="workbench.mjs" type="module"></script>',
                ),
            )
          : data,
      );
    }
    await writeFile(marker, spec.sha256);
  }
  const result = new Map<string, string>();
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (!entry.name.startsWith("."))
        result.set(
          "pdf-viewer/" + path.relative(base, file).split(path.sep).join("/"),
          file,
        );
    }
  }
  await visit(base);
  for (const extension of ["mjs", "css"])
    result.set(
      `pdf-viewer/web/workbench.${extension}`,
      path.join(
        root,
        `apps/workbench/src/workspace/reader/pdf-bridge.${extension}`,
      ),
    );
  return result;
}
