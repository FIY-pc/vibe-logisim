/**
 * A scripted model service for driving real AI turns without a model: an
 * OpenAI-compatible Chat Completions endpoint whose every answer comes from a
 * script function. The function sees the question and every tool call of the
 * turn so far with its parsed result, and returns the next step: some text,
 * a tool call, or both. The sidecar, the tools, the host and the window run
 * for real; only the model is replaced.
 *
 *   import { startScriptedModel } from "./scripted-model.mts";
 *   const model = await startScriptedModel(({ calls }) => steps[calls.length]?.(calls) ?? { text: "完成。" });
 *
 * CLI (for a preview host whose profile points at the port):
 *   node scripts/workbench/scripted-model.mts --port 8903 --script scripts/workbench/turns/full-adder.mts
 * The script module's default export is the Script; it may branch on `question`.
 * `GET /fixture/last-request` returns the newest request body.
 */
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}
export interface Step {
  text?: string;
  tool?: ToolCall;
  /** Waited before the step is sent, to show a running turn. */
  delayMs?: number;
}
/** One tool call of the current turn and what it returned. */
export interface Exchange {
  name: string;
  args: any;
  /** The parsed JSON result, or the error object of a failed call. */
  result: any;
  error: any | null;
  /** Whether an image followed the result. */
  image: boolean;
}
export interface Turn {
  /** The user's question of this turn (the workspace context is stripped). */
  question: string;
  calls: Exchange[];
  /** The full request, for scripts that need the tool declarations. */
  request: any;
}
export type Script = (turn: Turn) => Step | Promise<Step>;

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part: any) => (part?.type === "text" ? part.text : ""))
          .join("")
      : "";
const IMAGE_NOTICE = "Attached image(s) from tool result:";

/** The current turn as the script sees it, from a Chat Completions request. */
export function turnOf(request: any): Turn {
  const messages: any[] = request.messages || [];
  const start = messages.findLastIndex(
    (m) => m.role === "user" && !textOf(m.content).startsWith(IMAGE_NOTICE),
  );
  const names = new Map<string, { name: string; args: any }>();
  const calls: Exchange[] = [];
  for (const m of messages.slice(start + 1)) {
    for (const call of m.tool_calls || []) {
      let args: any = {};
      try {
        args = JSON.parse(call.function?.arguments || "{}");
      } catch {}
      names.set(call.id, { name: call.function?.name, args });
    }
    if (m.role === "tool") {
      const call = names.get(m.tool_call_id) ?? { name: m.name, args: {} };
      let result: any = textOf(m.content);
      try {
        result = JSON.parse(result);
      } catch {}
      calls.push({
        name: call.name,
        args: call.args,
        result,
        error: result && typeof result === "object" ? (result.error ?? null) : null,
        image: false,
      });
    }
    if (m.role === "user" && textOf(m.content).startsWith(IMAGE_NOTICE) && calls.length)
      calls[calls.length - 1].image = true;
  }
  // The runner appends the workspace context to the question.
  const question = textOf(messages[start]?.content).split(
    "\n\n<workspace_context>",
  )[0];
  return { question, calls, request };
}

export async function startScriptedModel(
  script: Script,
  { port = 0, log = false }: { port?: number; log?: boolean } = {},
) {
  const requests: any[] = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.method === "GET" && req.url?.startsWith("/fixture/last-request")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(requests.at(-1) ?? null));
    }
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "fixture/tool-model", object: "model" }],
        }),
      );
    }
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions"))
      return res.writeHead(404).end();
    const request = JSON.parse(body);
    requests.push(request);
    const turn = turnOf(request);
    let step: Step;
    try {
      step = (await script(turn)) ?? { text: "完成。" };
    } catch (error: any) {
      step = { text: `脚本出错：${error?.stack ?? error}` };
    }
    if (log)
      console.error(
        `[model] step ${turn.calls.length}: ${step.tool ? step.tool.name + " " + JSON.stringify(step.tool.args).slice(0, 160) : JSON.stringify(step.text ?? "").slice(0, 80)}`,
      );
    if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
    const chunk = (delta: any, finish_reason: string | null = null) =>
      `data: ${JSON.stringify({
        id: "scripted-" + turn.calls.length,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: request.model || "fixture/tool-model",
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    if (step.text) res.write(chunk({ role: "assistant", content: step.text }));
    if (step.tool)
      res.write(
        chunk({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call-${turn.calls.length}-${Date.now()}`,
              type: "function",
              function: {
                name: step.tool.name,
                arguments: JSON.stringify(step.tool.args ?? {}),
              },
            },
          ],
        }),
      );
    res.write(chunk({}, step.tool ? "tool_calls" : "stop"));
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    port: address.port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The profile entry a sidecar needs to use the scripted model (no real key). */
export function scriptedProfile(url: string) {
  const id = "scripted-model";
  return {
    version: 2,
    defaultId: id,
    services: [
      {
        id,
        name: "脚本模型",
        baseUrl: url,
        apiKey: "fixture",
        model: "fixture/tool-model",
        models: ["fixture/tool-model"],
        effort: "none",
        contextWindow: 256000,
        api: "openai-completions",
        vision: true,
      },
    ],
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const option = (name: string) => {
    const i = process.argv.indexOf("--" + name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const file = option("script");
  if (!file) throw new Error("--script <module> is required");
  const script: Script = (await import(pathToFileURL(path.resolve(file)).href))
    .default;
  const model = await startScriptedModel(script, {
    port: Number(option("port") ?? 8903),
    log: true,
  });
  console.error(`scripted model on ${model.url} (${file})`);
}
