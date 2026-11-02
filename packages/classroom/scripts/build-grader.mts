import { readdir, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../../..");
const output = path.resolve(
  process.env.CLASSROOM_GRADER_BUILD ||
    path.join(root, ".workbench-cache/assessment"),
);
const jar = path.resolve(
  process.env.VIBE_LOGISIM_JAR ||
    path.join(root, ".workbench-cache/Logisim-ITA.jar"),
);
const javaHome = process.env.JAVA_HOME;
const binary = (name: string) =>
  javaHome
    ? path.join(
        javaHome,
        "bin",
        name + (process.platform === "win32" ? ".exe" : ""),
      )
    : name;
async function sources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((e) =>
        e.isDirectory()
          ? sources(path.join(dir, e.name))
          : Promise.resolve(
              e.name.endsWith(".java") ? [path.join(dir, e.name)] : [],
            ),
      ),
    )
  ).flat();
}
const files = [
  ...(await sources(path.join(root, "crates/logisim-runtime/java"))),
  ...(await sources(path.join(root, "packages/classroom/java"))),
].sort();
await mkdir(path.join(output, "classes"), { recursive: true });
function run(executable: string, args: string[]) {
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0)
    throw Error(result.stderr || result.error?.message || "Java编译失败");
}
run(binary("javac"), [
  "--release",
  "17",
  "-encoding",
  "UTF-8",
  "-cp",
  jar,
  "-d",
  path.join(output, "classes"),
  ...files,
]);
run(binary("jar"), [
  "cf",
  path.join(output, "grader-bridge.jar"),
  "-C",
  path.join(output, "classes"),
  ".",
]);
console.log("Built isolated grader: " + path.join(output, "grader-bridge.jar"));
