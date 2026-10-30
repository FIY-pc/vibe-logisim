import type { ClassroomUser } from "../../../../packages/classroom/src/types";
export interface ClassroomSession {
  server: string;
  token: string;
  user: ClassroomUser;
}
export function serverAddress(value: string) {
  const url = new URL(value);
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
  const response = await fetch(serverAddress(session.server) + "/api" + path, {
    method,
    headers: {
      ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(100000)])
      : AbortSignal.timeout(100000),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || `课堂服务返回 HTTP ${response.status}`);
  return result as T;
}
