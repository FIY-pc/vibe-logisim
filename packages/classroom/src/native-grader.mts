import { spawn } from "node:child_process";
import type { GradeRunner } from "./assessment-types.ts";
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
/** A fresh bounded JVM per submission, with an allowlisted circuit preflight. */
export function nativeGrader(config: {
  java: string;
  classPath: string;
  timeoutMs?: number;
}): GradeRunner {
  return async ({ xml, circuit, tests }) =>
    new Promise((resolve, reject) => {
      const request = `<simulate circuit="${escape(circuit)}">${tests
        .map(
          (t) =>
            `<vector>${Object.entries(t.inputs)
              .map(
                ([name, value]) =>
                  `<input name="${escape(name)}" value="${value}"/>`,
              )
              .join("")}</vector>`,
        )
        .join("")}</simulate>`;
      const child = spawn(
        config.java,
        [
          "-Xmx256m",
          "-Xss512k",
          "-Djava.awt.headless=true",
          "-Dfile.encoding=UTF-8",
          "-cp",
          config.classPath,
          "com.cburch.logisim.file.ClassroomGrader",
        ],
        {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          env: {
            PATH: process.env.PATH || "",
            LANG: "C.UTF-8",
            SYSTEMROOT: process.env.SYSTEMROOT || process.env.SystemRoot || "",
          },
        },
      );
      let output = "",
        finished = false;
      const end = (error?: Error, result?: any) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        end(new Error("评测超时，请检查组合逻辑反馈环路或缩小电路"));
      }, config.timeoutMs ?? 15000);
      child.on("error", () => end(new Error("评测运行时暂不可用，请联系教师")));
      child.stdout.on("data", (b) => {
        output += b;
        if (output.length > 2 * 1024 * 1024) {
          child.kill("SIGKILL");
          end(new Error("评测输出超过限制"));
        }
      });
      child.stderr.on("data", () => {});
      child.stdin.on("error", () => {});
      child.on("close", (code) => {
        if (code !== 0)
          return end(
            new Error(
              "电路无法评测，请检查引脚标签、位宽及连线；仅支持内置组合逻辑元件和项目内子电路",
            ),
          );
        try {
          const result = JSON.parse(output);
          if (
            !Array.isArray(result.rows) ||
            result.rows.length !== tests.length
          )
            throw Error();
          end(undefined, result);
        } catch {
          end(new Error("评测服务未返回完整结果，请重新提交"));
        }
      });
      child.stdin.end(
        Buffer.from(request).toString("base64") +
          "\t" +
          Buffer.from(xml).toString("base64"),
      );
    });
}
