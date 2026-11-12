import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../", import.meta.url));
const jsdom = createRequire(path.join(root, "package.json")).resolve("jsdom");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-ui-check-"));
const turnsOnly = process.argv.includes("--turns");
const updatesOnly = process.argv.includes("--updates");
try {
  const entry = path.join(temp, "entry.tsx");
  if (turnsOnly || updatesOnly)
    await fs.writeFile(
      entry,
      updatesOnly
        ? `import { verifyUpdates } from ${JSON.stringify(path.join(root, "scripts/workbench/ui/updates.tsx"))};\nawait verifyUpdates();process.exit(0);`
        : `import { verifyConversationTurns } from ${JSON.stringify(path.join(root, "scripts/workbench/ui/conversation-turns.tsx"))};\nawait verifyConversationTurns();process.exit(0);`,
    );
  await build({
    entryPoints: [
      turnsOnly || updatesOnly
        ? entry
        : path.join(root, "scripts/workbench/ui/scenarios.tsx"),
    ],
    bundle: true,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    // Includes styles imported by lazy readers. jsdom checks behavior only;
    // CSS, slide rendering and geometry are verified in the browser.
    loader: { ".css": "empty" },
    nodePaths: [
      path.join(root, "apps/workbench/node_modules"),
      path.join(root, "node_modules"),
    ],
    outfile: path.join(temp, "scenarios.mjs"),
    plugins: [
      {
        name: "host-fixture",
        setup(builder) {
          // Keep OOXML's optional native modules out of the jsdom bundle;
          // navigation uses the real installed key/wheel helpers.
          // External ESM imports need a file URL, including on Windows.
          builder.onResolve({ filter: /^ooxml-ui\/pptx$/ }, () => ({
            path: import.meta.resolve("ooxml-ui/pptx"),
            external: true,
          }));
          // A module worker has no meaning in jsdom: scenarios never arrange.
          builder.onResolve({ filter: /\?worker&url$/ }, () => ({
            path: "arrange-worker",
            namespace: "worker-url",
          }));
          builder.onLoad({ filter: /.*/, namespace: "worker-url" }, () => ({
            contents: 'export default "arrange-worker.js";',
          }));
          builder.onLoad({ filter: /[\\/]shared[\\/]transport\.ts$/ }, () => ({
            contents:
              "export const command=(v)=>globalThis.__command(v);export const desktop=()=>globalThis.__desktop??false;export const openPath=async()=>null;export const savePath=async()=>null;",
          }));
          builder.onLoad(
            { filter: /@tauri-apps[\\/]plugin-dialog[\\/].*\.js$/ },
            () => ({
              contents:
                "export const open=async()=>globalThis.__pickedFiles??null;export const save=async()=>globalThis.__saveTarget??null;",
            }),
          );
          builder.onLoad(
            { filter: /@tauri-apps[\\/]api[\\/]core\.js$/ },
            () => ({
              contents:
                "export const invoke=(name,args)=>globalThis.__nativeInvoke ? globalThis.__nativeInvoke(name,args) : window.__TAURI_INTERNALS__.invoke(name,args);",
            }),
          );
          builder.onLoad(
            { filter: /@tauri-apps[\\/]api[\\/]event\.js$/ },
            () => ({
              contents:
                "export const listen=async(name,handler)=>globalThis.__nativeListen?.(name,handler)??(()=>{});",
            }),
          );
          builder.onLoad(
            { filter: /@tauri-apps[\\/]api[\\/]webview\.js$/ },
            () => ({
              contents:
                "export const getCurrentWebview=()=>({onDragDropEvent:async(handler)=>{const handlers=globalThis.__fileDropHandlers??=new Set();handlers.add(handler);globalThis.__fileDropHandler=(event)=>{for(const callback of handlers)callback(event)};return ()=>{handlers.delete(handler);if(!handlers.size)delete globalThis.__fileDropHandler}}});",
            }),
          );
          builder.onLoad({ filter: /[\\/]shared[\\/]events\.ts$/ }, () => ({
            contents:
              "export const subscribeEvents=(fn)=>globalThis.__subscribe(fn);",
          }));
          builder.onLoad({ filter: /[\\/]workspace[\\/]pdf\.ts$/ }, () => ({
            contents:
              "export const openPdf=async()=>{throw new Error('PDF is not rendered under jsdom')};export const pageText=async()=>'';",
          }));
          // Routing fixtures carry opaque bytes, not presentation packages.
          // Real text extraction is checked separately with a valid PPTX.
          builder.onLoad(
            { filter: /[\\/]reader[\\/]presentationText\.ts$/ },
            () => ({
              contents:
                "export const presentationText=async()=>{throw new Error('PPTX text extraction is not exercised under jsdom; use a valid PPTX parser fixture')};",
            }),
          );
          // Keep the lazy reader module and CSS imports in the bundle, but do
          // not load the viewer's optional AI or native canvas dependencies.
          // Any attempt to render slides here must fail, not fake visual proof.
          builder.onResolve({ filter: /^pptx-react-viewer$/ }, () => ({
            path: "pptx-react-viewer",
            namespace: "presentation-renderer",
          }));
          builder.onLoad(
            { filter: /.*/, namespace: "presentation-renderer" },
            () => ({
              contents:
                "const unavailable=()=>{throw new Error('PPTX is not rendered under jsdom; verify in a browser')};export {unavailable as useViewerBuildingBlocks,unavailable as SlideCanvas,unavailable as renderToCanvas,unavailable as PptxI18nProvider};",
            }),
          );
        },
      },
    ],
  });
  await fs.writeFile(
    path.join(temp, "setup.mjs"),
    `
import {JSDOM} from ${JSON.stringify(pathToFileURL(jsdom).href)};
const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,sessionStorage:dom.window.sessionStorage,FormData:dom.window.FormData,HTMLElement:dom.window.HTMLElement,HTMLTextAreaElement:dom.window.HTMLTextAreaElement,HTMLDialogElement:dom.window.HTMLDialogElement,HTMLFormElement:dom.window.HTMLFormElement,HTMLButtonElement:dom.window.HTMLButtonElement,HTMLInputElement:dom.window.HTMLInputElement,HTMLSelectElement:dom.window.HTMLSelectElement,HTMLSpanElement:dom.window.HTMLSpanElement,HTMLDivElement:dom.window.HTMLDivElement,SVGElement:dom.window.SVGElement,Element:dom.window.Element,Node:dom.window.Node,Text:dom.window.Text,DocumentFragment:dom.window.DocumentFragment,MutationObserver:dom.window.MutationObserver,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),Event:dom.window.Event,CustomEvent:dom.window.CustomEvent,MouseEvent:dom.window.MouseEvent,KeyboardEvent:dom.window.KeyboardEvent,FocusEvent:dom.window.FocusEvent,devicePixelRatio:1,IS_REACT_ACT_ENVIRONMENT:true,requestAnimationFrame:(fn)=>setTimeout(fn,0),cancelAnimationFrame:(id)=>clearTimeout(id)});
// jsdom has no PointerEvent; the shared Select reads pointerType off it.
if(!dom.window.PointerEvent){dom.window.PointerEvent=class PointerEvent extends dom.window.MouseEvent{constructor(type,init={}){super(type,init);this.pointerType=init.pointerType??'mouse';this.pointerId=init.pointerId??1}}}
globalThis.PointerEvent=dom.window.PointerEvent;
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
// A context menu anchors to a rectangle at the pointer.
globalThis.DOMRect=dom.window.DOMRect;
globalThis.NodeFilter=dom.window.NodeFilter;
globalThis.Window=dom.window.Window;
globalThis.innerHeight=dom.window.innerHeight;
// jsdom has no text layout; these stubs support lifecycle tests, not geometry proof.
dom.window.Range.prototype.getClientRects=()=>[];
dom.window.Range.prototype.getBoundingClientRect=()=>new DOMRect();
globalThis.ResizeObserver=dom.window.ResizeObserver=class{constructor(fn){this.fn=fn}observe(target){this.fn([{target,contentRect:{width:600,height:400},borderBoxSize:[{inlineSize:0,blockSize:0}]}])}unobserve(){}disconnect(){}};
// Radix measures form controls through window's animation frames.
dom.window.requestAnimationFrame=globalThis.requestAnimationFrame;dom.window.cancelAnimationFrame=globalThis.cancelAnimationFrame;
// The editor picture paints through Canvas2D, which jsdom does not have.
dom.window.HTMLCanvasElement.prototype.getContext=()=>null;
HTMLElement.prototype.scrollIntoView=()=>{};HTMLElement.prototype.setPointerCapture=()=>{};HTMLElement.prototype.releasePointerCapture=()=>{};HTMLElement.prototype.hasPointerCapture=()=>false;
HTMLDialogElement.prototype.showModal=function(){this.open=true};HTMLDialogElement.prototype.close=function(){this.open=false};
await import('./scenarios.mjs');
`,
  );
  // A failed DOM identity assertion can otherwise inspect the entire React
  // object graph. Keep a bad test from exhausting the developer's machine.
  execFileSync(
    process.execPath,
    ["--max-old-space-size=768", path.join(temp, "setup.mjs")],
    {
      stdio: "inherit",
      // The classroom scenario waits on a one-second grading poller.
      timeout: turnsOnly || updatesOnly ? 60000 : 240000,
      killSignal: "SIGKILL",
    },
  );
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
