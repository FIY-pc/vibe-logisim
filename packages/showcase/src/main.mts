import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createShowcaseServer } from "./server.mts";
const database = path.resolve(
  process.env.SHOWCASE_DATABASE || ".showcase-data/showcase.sqlite",
);
await mkdir(path.dirname(database), { recursive: true, mode: 0o700 });
const app = createShowcaseServer({
  database,
  publicDir: path.resolve(
    process.env.SHOWCASE_PUBLIC || "packages/showcase/public",
  ),
  downloadsDir: process.env.SHOWCASE_DOWNLOADS,
  adminUsername: process.env.SHOWCASE_ADMIN_USERNAME || "admin",
  adminPasswordHash: process.env.SHOWCASE_ADMIN_PASSWORD_HASH || "",
  ipSecret: process.env.SHOWCASE_IP_SECRET || "",
  origin: process.env.SHOWCASE_ORIGIN,
  secureCookies: process.env.NODE_ENV === "production",
  trustProxy: process.env.SHOWCASE_TRUST_PROXY === "1",
});
app.server.listen(Number(process.env.SHOWCASE_PORT || 8811), "127.0.0.1", () =>
  console.log("Showcase service ready"),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => void app.close().then(() => process.exit(0)));
