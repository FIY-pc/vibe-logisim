import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readMaterial } from "../../packages/agent-runtime/src/materials/read.mts";
import { fileTools } from "../../packages/agent-runtime/src/tools/files.mts";

// A long document whose last requirement cannot fit in a short attachment.
function document() {
  const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ],
    pages: number[] = [];
  for (let page = 1; page <= 24; page++) {
    const id = objects.length + 1;
    pages.push(id);
    const text =
      page === 24
        ? "0 0 1 rg 40 40 220 150 re f"
        : `BT /F1 10 Tf 40 750 Td (${page === 23 ? "FINAL_REQUIREMENT " : ""}${"Document requirement. ".repeat(100)}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`,
      `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${pages.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  let pdf = "%PDF-1.7\n";
  const offsets = [0];
  objects.forEach((value, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${value}\nendobj\n`;
  });
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join(
      "",
    )}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return pdf;
}
const directory = await mkdtemp(path.join(tmpdir(), "vibe-material-"));
try {
  const file = path.join(directory, "requirements.pdf");
  await writeFile(file, document());
  const late = await readMaterial(file, {
    path: "requirements.pdf",
    page: 23,
    render: true,
  });
  assert.equal(late.pages, 24);
  assert.match(late.text!, /FINAL_REQUIREMENT/);
  assert.match(late.image!, /^data:image\/png;base64,/);
  const search = await readMaterial(file, {
    path: "requirements.pdf",
    query: "FINAL_REQUIREMENT",
  });
  assert.equal(search.nextPage, 21);
  assert.deepEqual(search.matches, []);
  const remaining = await readMaterial(file, {
    path: "requirements.pdf",
    query: "FINAL_REQUIREMENT",
    startPage: search.nextPage,
  });
  assert.deepEqual(
    remaining.matches?.map((match) => match.page),
    [23],
  );
  assert.equal(remaining.nextPage, undefined);
  const scan = await readMaterial(file, { path: "requirements.pdf", page: 24 });
  assert.equal(scan.scanned, true);
  assert.equal(scan.text, "");
  assert.match(scan.image!, /^data:image\/png;base64,/);
  const png = Buffer.from(scan.image!.split(",")[1], "base64");
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 1600);
  await assert.rejects(
    readMaterial(file, { path: "requirements.pdf", page: 25 }),
    /1–24/,
  );
  const controller = new AbortController();
  const stopped = readMaterial(
    file,
    { path: "requirements.pdf", render: true },
    controller.signal,
  );
  controller.abort();
  await assert.rejects(stopped, /停止/);
  const tool = fileTools({ root: directory, assertCurrent() {} }).find(
    (tool) => tool.name === "read_material",
  )!;
  await assert.rejects(
    tool.execute("outside", { path: "../outside.pdf" }),
    /工作区/,
  );
  if (process.platform !== "win32") {
    await symlink(path.join(directory, ".."), path.join(directory, "outside"));
    await assert.rejects(
      tool.execute("link", { path: "outside/outside.pdf" }),
      /工作区/,
    );
  }
  console.log(
    "PASS: material reading reaches late pages, continues search, renders pages without text, rejects invalid pages and outside paths, and cancels workers.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
