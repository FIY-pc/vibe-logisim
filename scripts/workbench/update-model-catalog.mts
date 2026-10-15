/** Explicit maintenance command; startup and packaging use the checked-in snapshot. */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  compact,
  URL,
  VERSION,
} from "../../packages/agent-runtime/core/model-catalog.mts";

const text = process.argv[2]
  ? await readFile(process.argv[2], "utf8")
  : await (async () => {
      const response = await fetch(URL, {
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      });
      if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
      return response.text();
    })();
const snapshot = {
  version: VERSION,
  source: URL,
  license: "MIT",
  retrievedAt: new Date().toISOString().slice(0, 10),
  providers: compact(JSON.parse(text)),
};
const target = path.resolve(
  import.meta.dirname,
  "../../packages/agent-runtime/core/model-catalog.snapshot.json",
);
await writeFile(target, JSON.stringify(snapshot));
console.log(
  `Updated ${Object.keys(snapshot.providers).length} provider catalogs.`,
);
