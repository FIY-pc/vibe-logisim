/** SSE client used by integration scenarios; bounded waiting for actual pushed state. */
export async function eventStream(url: string) {
  const abort = new AbortController(),
    events: any[] = [],
    waiters = new Set<() => void>();
  const response = await fetch(url + "/api/events", { signal: abort.signal });
  if (!response.ok || !response.body)
    throw new Error("Event stream unavailable");
  const body = response.body;
  let failure: unknown;
  const read = (async () => {
    let pending = "";
    const decoder = new TextDecoder();
    try {
      for await (const chunk of body) {
        pending += decoder.decode(chunk, { stream: true });
        let split;
        while ((split = pending.indexOf("\n\n")) >= 0) {
          const block = pending.slice(0, split);
          pending = pending.slice(split + 2);
          const data = block
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("\n");
          if (data) {
            events.push(JSON.parse(data));
            for (const notify of waiters) notify();
          }
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        failure = error;
        for (const notify of waiters) notify();
      }
    }
  })();
  async function wait(predicate: (event: any) => boolean, from = 0) {
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error("Timed out waiting for pushed event"));
      }, 30000);
      function check() {
        const value = events.slice(from).find(predicate);
        if (value || failure) {
          clearTimeout(timer);
          waiters.delete(check);
          if (value) resolve(value);
          else reject(failure);
        }
      }
      waiters.add(check);
      check();
    });
  }
  return {
    events,
    wait,
    async close() {
      abort.abort();
      await read;
    },
  };
}
