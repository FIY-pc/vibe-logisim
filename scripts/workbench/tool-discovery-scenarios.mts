import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runToolCall } from "@earendil-works/pi-agent-core";
import { ToolContext } from "../../packages/agent-runtime/src/tools/context.mts";
import { circuitTools } from "../../packages/agent-runtime/src/tools/index.mts";

/** Exercise discovery and recovery through the real tools, host and native runtime. */
export async function verifyToolDiscovery(
  post: (request: any) => Promise<any>,
) {
  const status = await post({ op: "status", summary: true });
  const file = path.join(status.folder.path, "component-notes.circ");
  const source =
    '<project source="2.7.1" version="1.0"><lib desc="#Wiring" name="signals"/><lib desc="#Base" name="notes"/><main name="main"/><circuit name="main"/></project>';
  await writeFile(file, source);
  const doc = await post({ op: "open", path: file });
  const context = new ToolContext({
    host: { call: post },
    folder: status.folder,
    emit() {},
    assertCurrent() {},
    userDocumentId: doc.id,
    userCircuit: "main",
  });
  const tools = circuitTools({ context, vision: false });
  assert(!tools.some((tool) => tool.name === "arrange_circuit"));
  const call = async (name: string, args: any) => {
    const toolCall = {
      type: "toolCall" as const,
      id: "check",
      name,
      arguments: args,
    };
    const { result, isError } = await runToolCall(toolCall, {
      tools,
      context: { messages: [], tools },
      assistantMessage: {
        role: "assistant",
        content: [toolCall],
        api: "openai-completions",
        provider: "test",
        model: "test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
    });
    const content = result.content.find((item) => item.type === "text");
    assert(content?.type === "text");
    return {
      failed: isError,
      value: JSON.parse(content.text),
    };
  };
  const review = await call("inspect_circuit", { layoutReview: {} });
  assert(!review.failed);
  assert.equal(review.value.readability.components, 0);
  assert.deepEqual(review.value.problems, []);
  assert.equal(
    await readFile(file, "utf8"),
    source,
    "layout review is read-only",
  );
  const catalog = (await call("describe_component", {})).value;
  assert(
    catalog.libraries.some(
      (group: any) =>
        group.library === "notes" &&
        group.components.some((part: any) => part.name === "Text"),
    ),
  );
  const missing = await call("describe_component", { tool: "NonexistentPart" });
  assert(missing.failed);
  assert.equal(missing.value.error.code, "COMPONENT_NOT_FOUND");
  assert.match(missing.value.error.hint, /describe_component/);

  const badProbe = await call("describe_component", {
    tool: "Probe",
    attributes: { width: "8", radix: "16" },
  });
  assert(
    badProbe.failed,
    "invalid attributes remain a refusal, not silent success",
  );
  assert.match(badProbe.value.error.message, /width/);
  assert.match(badProbe.value.error.message, /radix/);
  const probe = await call("describe_component", {
    tool: "Probe",
    attributes: { radix: "16" },
  });
  assert(!probe.failed);
  assert.equal(probe.value.attributes.radix.value, "16");
  assert.equal(
    await readFile(file, "utf8"),
    source,
    "queries never edit the file",
  );

  const text = await call("describe_component", {
    tool: "Text",
    attributes: { text: "Signal path", font: "SansSerif bold 18" },
  });
  assert(!text.failed, JSON.stringify(text.value));
  assert.equal(
    text.value.library,
    "notes",
    "resolve the actual library, not a fixed numeric id",
  );
  assert.equal(text.value.attributes.font.value, "SansSerif bold 18");
  assert.notEqual(text.value.attributes.font.editable, false);
  const parts = [
    {
      factory: "Pin",
      location: { x: 100, y: 100 },
      attributes: { width: "8" },
    },
    {
      factory: "Text",
      location: { x: 1000, y: 0 },
      attributes: { text: "Signal path", font: "SansSerif bold 18" },
    },
  ];
  const outside = await call("place_component", { components: parts });
  assert(outside.failed);
  assert.match(outside.value.error.message, /Text/);
  assert.equal(
    await readFile(file, "utf8"),
    source,
    "failed batch leaves every part unapplied",
  );
  parts[1].location.y = 100;
  const placed = await call("place_component", { components: parts });
  assert(!placed.failed, JSON.stringify(placed.value));
  assert.equal(placed.value.ids.components.length, 2);
  assert.match(await readFile(file, "utf8"), /SansSerif bold 18/);
  const changed = await call("set_attributes", {
    edits: [
      { componentId: "c1000_100", attributes: { font: "Dialog plain 16" } },
    ],
  });
  assert(!changed.failed, JSON.stringify(changed.value));
  assert.match(await readFile(file, "utf8"), /Dialog plain 16/);
  await call("undo_edit", {});
  await call("undo_edit", {});
  assert.equal(
    await readFile(file, "utf8"),
    source,
    "each successful operation remains one undo step",
  );
  console.log(
    "Verified native tool discovery, recoverable attribute refusals, Text font editing, atomic placement failure and undo.",
  );
}
