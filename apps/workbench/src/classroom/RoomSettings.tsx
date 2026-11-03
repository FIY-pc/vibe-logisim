import { Button, TextArea, TextField } from "@radix-ui/themes";
import type { Classroom } from "../../../../packages/classroom/src/types";

export function RoomSettings({
  classroom,
  busy,
  run,
  api,
  refresh,
  notify,
}: {
  classroom: Classroom;
  busy: boolean;
  run: (work: () => Promise<void>) => Promise<void>;
  api: <T>(path: string, method?: string, body?: unknown) => Promise<T>;
  refresh: () => Promise<void>;
  notify: (message: string) => void;
}) {
  return (
    <form
      className="classroom-settings-form"
      key={classroom.id}
      onSubmit={(e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(e.currentTarget));
        void run(async () => {
          await api(`/classrooms/${classroom.id}`, "PATCH", {
            ...data,
            capacity: Number(data.capacity),
          });
          await refresh();
          notify("课堂信息已更新");
        });
      }}
    >
      <h4>课堂信息</h4>
      <label>
        课堂名称
        <TextField.Root
          name="title"
          defaultValue={classroom.title}
          maxLength={120}
          required
        />
      </label>
      <label>
        课堂任务
        <TextArea
          name="task"
          defaultValue={classroom.task}
          maxLength={10000}
          rows={4}
        />
      </label>
      <label>
        评价标准
        <TextArea
          name="rubric"
          defaultValue={classroom.rubric}
          maxLength={5000}
          rows={3}
        />
      </label>
      <label>
        人数上限
        <TextField.Root
          name="capacity"
          type="number"
          min={Math.max(1, classroom.memberCount)}
          max={500}
          defaultValue={classroom.capacity}
          required
        />
      </label>
      <Button variant="solid" disabled={busy}>
        保存课堂信息
      </Button>
    </form>
  );
}
