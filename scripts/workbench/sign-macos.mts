import { open, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

/** Tauri signs the outer app; resources containing Node/JVM/native addons need signing first. */
export async function signMacosRuntimes(directory: string) {
  if (process.platform !== "darwin") return;
  const entitlements = path.resolve(
    import.meta.dirname,
    "../../apps/workbench/src-tauri/RuntimeEntitlements.plist",
  );
  const identity = process.env.APPLE_SIGNING_IDENTITY || "-";
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(file);
        continue;
      }
      if (!entry.isFile()) continue;
      const handle = await open(file, "r");
      const magic = Buffer.alloc(4);
      try {
        await handle.read(magic, 0, 4, 0);
      } finally {
        await handle.close();
      }
      if (
        ![
          "cffaedfe",
          "cefaedfe",
          "feedfacf",
          "feedface",
          "cafebabe",
          "bebafeca",
          "cafebabf",
          "bfbafeca",
        ].includes(magic.toString("hex"))
      )
        continue;
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          "/usr/bin/codesign",
          [
            "--force",
            "--sign",
            identity,
            "--options",
            "runtime",
            ...(identity === "-" ? [] : ["--timestamp"]),
            "--entitlements",
            entitlements,
            file,
          ],
          { stdio: "inherit" },
        );
        child.once("error", reject);
        child.once("exit", (code) =>
          code === 0
            ? resolve()
            : reject(
                new Error(`Runtime signing failed: ${path.basename(file)}`),
              ),
        );
      });
    }
  }
  await visit(directory);
}
