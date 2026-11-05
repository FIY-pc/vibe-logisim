import assert from "node:assert/strict";
import { Presentation } from "ooxml-core/pptx";
import { presentationText } from "../../apps/workbench/src/workspace/reader/presentationText.ts";

// Build two slides in memory, then reorder them to exercise presentation order.
const deck = await Presentation.create();
try {
  deck.addSlide("Blank").addText("全加器：Sum 与 Carry", {
    x: 40,
    y: 40,
    width: 600,
    height: 60,
    fontSize: 28,
  });
  deck.addSlide("Blank").addText("Carry = A AND B", {
    x: 40,
    y: 40,
    width: 600,
    height: 60,
    fontSize: 28,
  });
  deck.moveSlide(1, 0);
  const bytes = Buffer.from(await deck.save());
  const before = Buffer.from(bytes);
  const text = await presentationText(bytes.toString("base64"));
  assert.match(text, /共 2 页/);
  assert.match(text, /第 1 页\nCarry = A AND B/);
  assert.match(text, /第 2 页\n全加器：Sum 与 Carry/);
  assert.match(text, /不含图像中的文字/);
  assert.deepEqual(bytes, before);
  await assert.rejects(
    presentationText(Buffer.from("not a presentation").toString("base64")),
  );
  console.log(
    "PPTX quotation: page order, Chinese text, source bytes and invalid input passed",
  );
} finally {
  deck.dispose();
}
