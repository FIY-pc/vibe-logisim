import type { ClassroomUser } from "../../../../packages/classroom/src/types";
export interface ClassroomSession {
  server: string;
  token: string;
  user: ClassroomUser;
}
export function serverAddress(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("请输入完整的课堂服务地址（以 http:// 或 https:// 开头）");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("请输入 http 或 https 课堂服务地址");
  return url.href.replace(/\/+$/, "");
}
export async function classroomRequest<T>(
  session: Pick<ClassroomSession, "server"> &
    Partial<Pick<ClassroomSession, "token">>,
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const server = serverAddress(session.server);
  const headers: Record<string, string> = {
    ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}),
    ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
  };
  const json = body === undefined ? undefined : JSON.stringify(body);
  let payload: string | ArrayBuffer | undefined = json;
  if (json && json.length > 65536 && typeof CompressionStream !== "undefined") {
    payload = await new Response(
      new Blob([json]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer();
    headers["Content-Encoding"] = "gzip";
  }
  let response: Response;
  try {
    response = await fetch(server + "/api" + path, {
      method,
      headers,
      body: payload,
      signal: signal
        ? AbortSignal.any([
            signal,
            AbortSignal.timeout(path.endsWith("/analysis") ? 100000 : 20000),
          ])
        : AbortSignal.timeout(path.endsWith("/analysis") ? 100000 : 20000),
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new Error(
      `无法连接课堂服务 ${server}，请检查服务地址和网络${new URL(server).hostname === "lovej.site" ? "。线上地址应为 https://lovej.site/vibe-classroom（不加端口）" : "，确认端口及 HTTPS 证书有效"}`,
    );
  }
  const result = await response.json().catch(() => {
    throw Object.assign(
      new Error(
        `课堂服务返回了无效数据（HTTP ${response.status}），请检查服务地址或稍后重试`,
      ),
      { status: response.status },
    );
  });
  if (!response.ok)
    throw Object.assign(
      new Error(result.error || `课堂服务返回 HTTP ${response.status}`),
      { status: response.status },
    );
  return result as T;
}
