import { runtimeFetch } from "./network.mts";
import { RuntimeInstaller } from "../core/runtime-installer.mts";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { x } from "tar";

export async function extractRuntime(
  archive: string,
  target: string,
  signal: AbortSignal,
) {
  let count = 0,
    total = 0;
  let failure: Error | undefined;
  await x({
    file: archive,
    cwd: target,
    strict: true,
    preservePaths: false,
    keep: true,
    filter(name, entry) {
      if (failure) return false;
      if (signal.aborted) {
        failure =
          signal.reason instanceof Error
            ? signal.reason
            : new Error("安装已取消");
        return false;
      }
      const normalized = name.replaceAll("\\", "/");
      if (
        normalized.startsWith("/") ||
        normalized.split("/").includes("..") ||
        normalized.includes(":") ||
        !("type" in entry && ["File", "Directory"].includes(entry.type))
      ) {
        failure = new Error("运行时归档包含无效路径或链接");
        return false;
      }
      total += entry.size;
      if (++count > 10000 || total > 1024 * 1024 * 1024) {
        failure = new Error("运行时归档超出限制");
        return false;
      }
      return true;
    },
  });
  if (failure) throw failure;
  signal.throwIfAborted();
}
export async function createCodexInstaller(state: string) {
  if (process.env.VIBE_LOGISIM_CODEX)
    return {
      installer: null,
      codexRoot: null,
      codex: process.env.VIBE_LOGISIM_CODEX,
    };
  const lock = JSON.parse(
    await readFile(
      new URL("../../../config/runtime-lock.json", import.meta.url),
      "utf8",
    ),
  );
  const target = `${process.platform}-${process.arch}`;
  const pinned = lock.targets[target]?.artifacts.codex;
  if (!pinned) throw new Error("当前平台没有已验证的 Codex 分发包");
  const ext = process.platform === "win32" ? ".exe" : "";
  const spec = {
    ...pinned,
    target,
    programs: [`bin/codex${ext}`, `bin/codex-code-mode-host${ext}`],
  };
  const codexRoot = path.join(
    state,
    "runtimes",
    "codex",
    spec.sha256.slice(0, 16),
  );
  process.env.VIBE_LOGISIM_CODE_MODE_HOST = path.join(
    codexRoot,
    spec.programs[1],
  );
  return {
    codexRoot,
    codex: path.join(codexRoot, spec.programs[0]),
    installer: new RuntimeInstaller({
      spec,
      directory: codexRoot,
      extract: extractRuntime,
      fetch: runtimeFetch,
    }),
  };
}
