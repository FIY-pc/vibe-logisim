import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createClassroomServer } from "./server.mts";

const database = path.resolve(
  process.env.CLASSROOM_DATABASE || ".classroom-data/classroom.sqlite",
);
await mkdir(path.dirname(database), { recursive: true, mode: 0o700 });
const {
  CLASSROOM_AI_BASE_URL: baseUrl,
  CLASSROOM_AI_API_KEY: apiKey,
  CLASSROOM_AI_MODEL: model,
} = process.env;
if (
  [baseUrl, apiKey, model].some(Boolean) &&
  ![baseUrl, apiKey, model].every(Boolean)
)
  throw new Error(
    "请完整配置 CLASSROOM_AI_BASE_URL、CLASSROOM_AI_API_KEY 和 CLASSROOM_AI_MODEL",
  );
const app = createClassroomServer({
  database,
  teacherCode: process.env.CLASSROOM_TEACHER_CODE || "",
  origins: process.env.CLASSROOM_ORIGINS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  ...(baseUrl && apiKey && model ? { ai: { baseUrl, apiKey, model } } : {}),
});
const port = Number(process.env.CLASSROOM_PORT || 8810),
  host = process.env.CLASSROOM_HOST || "127.0.0.1";
app.server.listen(port, host, () =>
  console.log(`Classroom service: http://${host}:${port}`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
