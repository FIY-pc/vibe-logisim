import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { WorkSnapshot } from "./types.ts";

/** Chat changes do not duplicate megabytes of unchanged circuit XML and PNG in every record. */
export function snapshotContent(db: DatabaseSync) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS snapshot_content(id TEXT PRIMARY KEY,xml TEXT NOT NULL,image TEXT)",
  );
  return {
    read(raw: string): WorkSnapshot {
      const s = JSON.parse(raw);
      if (!s.contentId) return s; // Historical full snapshots remain readable.
      const content = db
        .prepare("SELECT xml,image FROM snapshot_content WHERE id=?")
        .get(s.contentId) as { xml: string; image: string | null } | undefined;
      if (!content) throw new Error("Snapshot content is missing");
      const { contentId: _, ...rest } = s;
      return {
        ...rest,
        xml: content.xml,
        ...(content.image ? { image: content.image } : {}),
      };
    },
    write(snapshot: WorkSnapshot) {
      const { xml, image, ...rest } = snapshot;
      const contentId = createHash("sha256")
        .update(JSON.stringify([xml, image || null]))
        .digest("hex");
      db.prepare("INSERT OR IGNORE INTO snapshot_content VALUES(?,?,?)").run(
        contentId,
        xml,
        image || null,
      );
      return JSON.stringify({ ...rest, contentId });
    },
  };
}
