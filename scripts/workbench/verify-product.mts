/** Run the product resources outside the checkout with no system Java/Node on the child PATH. */
import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../..");
const directory = await mkdtemp(path.join(tmpdir(), "Vibe product check "));
try {
  const resources = path.join(directory, "resources/workbench");
  await cp(path.join(root, ".workbench-cache/product"), resources, {
    recursive: true,
    dereference: true,
  });
  const binary =
    "vibe-workbench-host" + (process.platform === "win32" ? ".exe" : "");
  const host = path.join(directory, binary);
  await cp(path.join(root, "target/debug", binary), host);
  const env = {
    ...process.env,
    VIBE_VERIFY_HOST: host,
    VIBE_VERIFY_CWD: directory,
    VIBE_WORKBENCH_RESOURCES: resources,
  };
  for (const key of Object.keys(env))
    if (key.toLowerCase() === "path") delete env[key as keyof typeof env];
  Object.assign(env, { PATH: path.join(directory, "no-system-runtimes") });
  for (const key of [
    "VIBE_LOGISIM_JAR",
    "VIBE_LOGISIM_AGENT_ROOT",
    "VIBE_LOGISIM_NODE",
    "NODE_PATH",
    "JAVA_HOME",
  ])
    delete env[key as keyof typeof env];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(root, "scripts/workbench/verify.mts")],
      { cwd: directory, env, stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("Relocated product verification exited " + code)),
    );
  });
  console.log(
    "Verified relocated resources with bundled Java and Node, precompiled bridge, local model, and an empty system runtime PATH.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
