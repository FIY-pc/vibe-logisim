import type { Request } from "../generated/Request";
import { invoke } from "@tauri-apps/api/core";
export const desktop = () => "__TAURI_INTERNALS__" in window;
export async function command<T = unknown>(request: Request): Promise<T> {
  if (desktop()) return invoke<T>("command", { request });
  const response = await fetch("/api/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || "请求失败");
  return data.result as T;
}
export async function openPath(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const result = await open({
    multiple: false,
    filters: [{ name: "Logisim", extensions: ["circ"] }],
  });
  return typeof result === "string" ? result : null;
}
export async function savePath(name: string): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({
    defaultPath: name,
    filters: [{ name: "Logisim", extensions: ["circ"] }],
  });
}
