import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { bindPresentationNavigation } from "../../apps/workbench/src/workspace/reader/presentationNavigation.ts";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const dom = new JSDOM(
  '<div id="canvas" tabindex="0"><div id="viewport"><p>slide text</p></div><input></div><textarea></textarea>',
);
const document = dom.window.document as Document;
const priorElement = globalThis.Element;
globalThis.Element = dom.window.Element;
const canvas = document.querySelector<HTMLElement>("#canvas")!;
const viewport = document.querySelector<HTMLElement>("#viewport")!;
const slide = document.querySelector<HTMLElement>("p")!;
let page = 3,
  enabled = true,
  bottom = 500;
viewport.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 800, 600);
slide.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 800, bottom);
const stop = bindPresentationNavigation(canvas, () => ({
  enabled,
  page,
  count: 20,
  viewport,
  slide,
  goTo(next) {
    page = Math.max(1, Math.min(20, next));
  },
}));
const key = (
  key: string,
  target: Element = canvas,
  options: KeyboardEventInit = {},
) => {
  const event = new dom.window.KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
};
const wheel = (time: number, options: WheelEventInit = {}) => {
  const event = new dom.window.WheelEvent("wheel", {
    deltaY: 240,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  Object.defineProperty(event, "timeStamp", { value: time });
  slide.dispatchEvent(event);
  return event.defaultPrevented;
};
try {
  assert(key("ArrowRight"));
  assert.equal(page, 4);
  key("PageUp");
  assert.equal(page, 3);
  key("End");
  key("ArrowRight");
  assert.equal(page, 20);
  key("Home");
  key("ArrowLeft");
  assert.equal(page, 1);
  key(" ");
  key(" ", canvas, { shiftKey: true });
  assert.equal(page, 1);
  key("ArrowRight", canvas, { repeat: true });
  assert.equal(page, 1);
  for (const options of [
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
    { shiftKey: true },
    { isComposing: true },
  ])
    assert.equal(key("ArrowRight", canvas, options), false);
  assert.equal(key("ArrowRight", document.querySelector("input")!), false);
  assert.equal(key("ArrowRight", document.querySelector("textarea")!), false);
  const range = document.createRange();
  range.selectNodeContents(slide);
  document.getSelection()!.addRange(range);
  assert.equal(key("ArrowRight"), false);
  document.getSelection()!.removeAllRanges();
  assert.equal(page, 1);

  assert(wheel(1000));
  assert.equal(page, 2);
  for (const time of [1010, 1040, 1100, 1250]) wheel(time);
  assert.equal(
    page,
    6,
    "Continued scrolling must keep turning pages without a pause",
  );
  wheel(1500);
  assert.equal(page, 7);
  wheel(1510, { deltaY: -240 });
  assert.equal(page, 6);
  for (let time = 1520; time <= 1620; time += 10) wheel(time, { deltaY: 10 });
  assert.equal(
    page,
    6,
    "Fine trackpad movement must accumulate rather than flip on every event",
  );
  wheel(1630, { deltaY: 10 });
  assert.equal(page, 7);
  for (let time = 1640; time <= 1750; time += 10) wheel(time, { deltaY: 10 });
  assert.equal(
    page,
    8,
    "A second accumulated step turns again in the same gesture",
  );
  assert.equal(wheel(1800, { ctrlKey: true }), false);
  assert.equal(wheel(2000, { deltaX: 300 }), false);
  assert.equal(page, 8, "Zoom and horizontal panning belong to the renderer");

  bottom = 900;
  assert.equal(
    wheel(2500),
    false,
    "A zoomed slide must scroll before it turns",
  );
  bottom = 500;
  assert(wheel(2550));
  assert.equal(
    page,
    9,
    "Continued scrolling at the edge turns without a fresh gesture",
  );
  wheel(2560);
  assert.equal(page, 10);
  key("End");
  wheel(2600);
  assert.equal(page, 20, "Continued scrolling must stop at the last page");
  key("Home");
  wheel(2700, { deltaY: -240 });
  assert.equal(page, 1, "Continued scrolling must stop at the first page");
  wheel(2800, { deltaY: 3, deltaMode: 1 });
  wheel(2810, { deltaY: 3, deltaMode: 1 });
  assert.equal(page, 1);
  wheel(2820, { deltaY: 3, deltaMode: 1 });
  assert.equal(
    page,
    2,
    "Line-based mouse wheels use the same accumulated navigation",
  );
  wheel(3000, { deltaY: 3, deltaMode: 1 });
  wheel(3500, { deltaY: 3, deltaMode: 1 });
  wheel(4000, { deltaY: 3, deltaMode: 1 });
  assert.equal(page, 3, "Slow wheel notches must accumulate too");
  enabled = false;
  assert.equal(key("PageDown"), false);
  assert.equal(wheel(4200), false);
  enabled = true;
  stop();
  key("PageDown");
  wheel(4500);
  assert.equal(page, 3);
  console.log(
    "PPTX navigation: scoped keys, selection, continuous wheel paging, zoom scrolling and cleanup passed",
  );
} finally {
  stop();
  globalThis.Element = priorElement;
  dom.window.close();
}
