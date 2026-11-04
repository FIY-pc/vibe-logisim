/** Native catalog, font persistence and atomic placement; synthetic circuits only. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

type Command = (request: any) => Promise<any>;
const entries = (node: any, tag: string) =>
  (node.children ?? []).filter((entry: any) => entry.tag === tag);
const attribute = (node: any, name: string) =>
  entries(node, "attribute").find(
    (entry: any) => entry.attributes.name === name,
  )?.attributes;

export async function verifyNativeComponents(command: Command) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "vibe-native-components-"),
  );
  try {
    const fresh = await command({ op: "new", name: "native-components.circ" });
    const freshSource = (await command({ op: "source", id: fresh.id })).xml;
    for (const version of ["2.7.1", "2.15.0.2"]) {
      let doc = await command({
        op: "import",
        name: `native-${version}.circ`,
        xml: freshSource
          .replace('source="2.7.1"', `source="${version}"`)
          .replace(
            "</project>",
            '<circuit name="child"><comp lib="0" name="Pin" loc="(100,100)"/></circuit></project>',
          ),
      });
      const scope = () => ({
        id: doc.id,
        revision: doc.revision,
        circuit: "main",
      });
      const source = async () =>
        (await command({ op: "source", ...scope() })).xml;
      const edit = async (edit: any) => {
        await command({ op: "edit", ...scope(), edit });
        doc = await command({ op: "read", id: doc.id });
      };
      const catalog = await command({ op: "catalog", ...scope() });
      const library = (name: string) => {
        const hits = entries(catalog, "group").filter((group: any) =>
          entries(group, "tool").some(
            (tool: any) => tool.attributes.name === name,
          ),
        );
        assert.equal(
          hits.length,
          1,
          `${name} must be discoverable without a guessed library`,
        );
        return hits[0].attributes.id;
      };
      library("Text");
      const wiring = library("Pin");
      assert.equal(library("Probe"), wiring);
      assert.equal(library("child"), "");
      const template = (name: string, attributes = {}) =>
        command({
          op: "template",
          ...scope(),
          library: library(name),
          name,
          attributes,
        });
      const font = "SansSerif bold 18";
      assert.equal(
        attribute(await template("Text", { text: "Heading", font }), "font")
          ?.editable,
        "true",
      );
      for (const bad of [
        "SansSerif bold banana",
        "NoSuchFontForNativeCheck plain 18",
        "SansSerif bold 0",
      ]) {
        await assert.rejects(() => template("Text", { font: bad }), /font/);
      }
      const place = (name: string, x: number, y: number, attributes = {}) => ({
        kind: "place",
        name,
        library: library(name),
        location: { x, y },
        attributes,
      });
      const title = place("Text", 870, 10, { text: "Heading", font });
      const before = await source(),
        beforeRevision = doc.revision;
      const history = await command({ op: "historyList", id: doc.id });
      const batch = [
        ...Array.from({ length: 47 }, (_, i) =>
          place(
            "Probe",
            100 + i * 40,
            300,
            i === 0 ? { label: "probe", labelfont: font } : {},
          ),
        ),
        title,
      ];
      let failure: any;
      try {
        await edit({ kind: "batch", edits: batch });
      } catch (error) {
        failure = error;
      }
      assert(
        failure,
        "Text's native bounds must reject a heading above the canvas",
      );
      assert.match(failure.message, /第 48 项.*Text.*870, 10/);
      assert.match(failure.message, /实际边界.*向下至少移动/);
      assert.equal(
        await source(),
        before,
        "Rejected batch must leave source bytes unchanged",
      );
      assert.equal(
        (await command({ op: "read", id: doc.id })).revision,
        beforeRevision,
      );
      assert.deepEqual(
        await command({ op: "historyList", id: doc.id }),
        history,
      );
      for (const [edits, reason] of [
        [
          [place("Probe", 100, 100), place("Probe", 100, 100)],
          /第 2 项.*Probe.*100, 100.*相同元件/,
        ],
        [
          [place("Pin", 100, 100), place("Probe", 200, 100, { width: "8" })],
          /第 2 项.*Probe.*200, 100.*当前可编辑属性/,
        ],
      ] as const) {
        await assert.rejects(() => edit({ kind: "batch", edits }), reason);
        assert.equal(await source(), before);
        assert.deepEqual(
          await command({ op: "historyList", id: doc.id }),
          history,
        );
      }
      const suggested = failure.message.match(/可将锚点改为 \((\d+), (\d+)\)/);
      assert(suggested, failure.message);
      title.location = { x: Number(suggested[1]), y: Number(suggested[2]) };
      await edit({ kind: "batch", edits: batch });
      assert.equal(
        doc.circuits.find((c: any) => c.name === "main").components.length,
        48,
      );
      const text = () =>
        doc.circuits
          .find((c: any) => c.name === "main")
          .components.find((c: any) => c.name === "Text");
      assert.deepEqual(
        text().location,
        title.location,
        "No implicit relocation",
      );
      await edit({
        kind: "attributes",
        id: text().id,
        values: { font: "Serif italic 16" },
      });
      const afterFont = await source();
      await assert.rejects(
        () =>
          edit({
            kind: "attributes",
            id: text().id,
            values: { font: "Serif bold nope" },
          }),
        /font/,
      );
      assert.equal(
        await source(),
        afterFont,
        "Invalid font edit must not downgrade or mutate text",
      );
      await edit({
        kind: "batch",
        edits: [
          place("Pin", 100, 500, { label: "input", labelfont: font }),
          place("child", 400, 500, { label: "instance", labelfont: font }),
        ],
      });
      const properties = await command({
        op: "properties",
        ...scope(),
        component: text().id,
      });
      assert.equal(attribute(properties, "font")?.value, "Serif italic 16");
      assert.equal(attribute(properties, "font")?.editable, "true");
      const file = path.join(directory, `native-${version}.circ`);
      doc = await command({ op: "save", ...scope(), path: file });
      const saved = await readFile(file, "utf8");
      assert.match(saved, /Serif italic 16/);
      await command({ op: "close", id: doc.id, revision: doc.revision });
      doc = await command({ op: "open", path: file });
      assert.equal(text().attributes.font, "Serif italic 16");
      assert.deepEqual(text().location, title.location);
      for (const name of ["Pin", "Probe", "child"]) {
        const component = doc.circuits
          .find((c: any) => c.name === "main")
          .components.find((c: any) => c.name === name && c.attributes.label);
        assert.equal(
          component.attributes.labelfont,
          font,
          `${name} label font must survive reopening`,
        );
      }
      const observed = (await command({ op: "observe", ...scope() })).focus;
      assert.equal(
        observed.components.length,
        50,
        "Saved parts must load in the native runtime",
      );
      assert(observed.components.some((c: any) => c.factoryName === "Text"));
      assert(observed.components.some((c: any) => c.factoryName === "child"));
      const symbols = await command({
        op: "symbols",
        ...scope(),
        symbols: [
          {
            name: "Text",
            library: library("Text"),
            attributes: text().attributes,
          },
        ],
      });
      assert(
        symbols.symbols[0].ops.some(
          (op: any[]) =>
            op[0] === "F" && op[1] === "Serif" && op[2] === 2 && op[3] === 16,
        ),
        "Native drawing must use the saved font, style and size",
      );
      const simulation = await command({
        op: "simulate",
        ...scope(),
        vectors: [{ inputs: { input: 0 } }, { inputs: { input: 1 } }],
      });
      assert.equal(simulation.failed, 0);
      assert.equal(simulation.unchecked, 2);
      assert.equal(await readFile(file, "utf8"), saved);
      await command({ op: "close", id: doc.id, revision: doc.revision });
      console.log(
        `Verified native ${version}: Text/Pin/Probe/subcircuit discovery; font describe/place/edit/save/reopen; 48-item placement failure and atomic retry.`,
      );
    }
    await command({
      op: "close",
      id: fresh.id,
      revision: fresh.revision,
      discard: true,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
