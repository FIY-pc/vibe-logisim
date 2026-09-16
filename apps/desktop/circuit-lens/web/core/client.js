"use strict";

function errorMessage(payload, fallback) {
  return payload?.error?.message || payload?.message || fallback;
}

export function createStudioClient(fetchImpl = fetch) {
  async function request(path, options = {}) {
    const response = await fetchImpl(path, {
      cache: "no-store",
      ...options,
      headers: { Accept: "application/json", ...(options.headers || {}) },
    });
    if (response.status === 204) return null;
    const type = response.headers.get("content-type") || "";
    const payload = type.includes("json") ? await response.json() : await response.text();
    if (!response.ok) {
      const error = new Error(errorMessage(payload, `请求失败（${response.status}）`));
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }
  const json = (path, value, method = "POST") => request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  return Object.freeze({
    request,
    session: () => request("/api/session"),
    circuits: () => request("/api/circuits"),
    circuit: name => request(`/api/circuit?name=${encodeURIComponent(name)}`),
    selection: ref => request(`/api/selection?${new URLSearchParams(ref || {})}`),
    review: () => request("/api/review"),
    projectAction: (action, value) => json(`/api/project/${action}`, value),
    simulationAction: value => json("/api/simulation", value),
    agentTool: value => json("/api/agent/tool", value),
    saveSelection: value => json("/api/selection", value),
    query: value => json("/api/query", value),
  });
}
