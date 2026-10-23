import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../", import.meta.url));
const jsdom = createRequire(path.join(root, "package.json")).resolve("jsdom");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-ui-check-"));
try {
  await build({
    entryPoints: [path.join(root, "scripts/workbench/ui/scenarios.tsx")],
    bundle: true,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    nodePaths: [
      path.join(root, "apps/workbench/node_modules"),
      path.join(root, "node_modules"),
    ],
    outfile: path.join(temp, "scenarios.mjs"),
    plugins: [
      {
        name: "host-fixture",
        setup(builder) {
          // A module worker has no meaning in jsdom: scenarios never arrange.
          builder.onResolve({ filter: /\?worker&url$/ }, () => ({
            path: "arrange-worker",
            namespace: "worker-url",
          }));
          builder.onLoad({ filter: /.*/, namespace: "worker-url" }, () => ({
            contents: 'export default "arrange-worker.js";',
          }));
          builder.onLoad({ filter: /\/shared\/transport\.ts$/ }, () => ({
            contents:
              "export const command=(v)=>globalThis.__command(v);export const desktop=()=>globalThis.__desktop??false;export const openPath=async()=>null;export const savePath=async()=>null;",
          }));
          builder.onLoad(
            { filter: /@tauri-apps\/plugin-dialog\/.*\.js$/ },
            () => ({
              contents:
                "export const open=async()=>globalThis.__pickedFiles??null;export const save=async()=>globalThis.__saveTarget??null;",
            }),
          );
          builder.onLoad({ filter: /@tauri-apps\/api\/webview\.js$/ }, () => ({
            contents:
              "export const getCurrentWebview=()=>({onDragDropEvent:async(handler)=>{globalThis.__fileDropHandler=handler;return ()=>{if(globalThis.__fileDropHandler===handler)delete globalThis.__fileDropHandler}}});",
          }));
          builder.onLoad({ filter: /\/shared\/events\.ts$/ }, () => ({
            contents:
              "export const subscribeEvents=(fn)=>globalThis.__subscribe(fn);",
          }));
          builder.onLoad({ filter: /\/workspace\/FilePreview\.tsx$/ }, () => ({
            contents: "export const FilePreview=()=>null;",
          }));
          builder.onLoad({ filter: /\/workspace\/pdf\.ts$/ }, () => ({
            contents:
              "export const openPdf=async()=>{throw new Error('PDF is not rendered under jsdom')};export const pageText=async()=>'';",
          }));
        },
      },
    ],
  });
  await fs.writeFile(
    path.join(temp, "setup.mjs"),
    `
import {JSDOM} from ${JSON.stringify(jsdom)};
const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,HTMLTextAreaElement:dom.window.HTMLTextAreaElement,HTMLDialogElement:dom.window.HTMLDialogElement,HTMLFormElement:dom.window.HTMLFormElement,HTMLButtonElement:dom.window.HTMLButtonElement,HTMLInputElement:dom.window.HTMLInputElement,HTMLSelectElement:dom.window.HTMLSelectElement,HTMLSpanElement:dom.window.HTMLSpanElement,HTMLDivElement:dom.window.HTMLDivElement,SVGElement:dom.window.SVGElement,Element:dom.window.Element,Node:dom.window.Node,Text:dom.window.Text,DocumentFragment:dom.window.DocumentFragment,MutationObserver:dom.window.MutationObserver,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),Event:dom.window.Event,CustomEvent:dom.window.CustomEvent,MouseEvent:dom.window.MouseEvent,KeyboardEvent:dom.window.KeyboardEvent,FocusEvent:dom.window.FocusEvent,devicePixelRatio:1,IS_REACT_ACT_ENVIRONMENT:true,requestAnimationFrame:(fn)=>setTimeout(fn,0),cancelAnimationFrame:(id)=>clearTimeout(id)});
// jsdom has no PointerEvent; the shared Select reads pointerType off it.
if(!dom.window.PointerEvent){dom.window.PointerEvent=class PointerEvent extends dom.window.MouseEvent{constructor(type,init={}){super(type,init);this.pointerType=init.pointerType??'mouse';this.pointerId=init.pointerId??1}}}
globalThis.PointerEvent=dom.window.PointerEvent;
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
// A context menu anchors to a rectangle at the pointer.
globalThis.DOMRect=dom.window.DOMRect;
globalThis.ResizeObserver=class{constructor(fn){this.fn=fn}observe(){this.fn([{contentRect:{width:600,height:400}}])}disconnect(){}};
HTMLElement.prototype.scrollIntoView=()=>{};HTMLElement.prototype.setPointerCapture=()=>{};HTMLElement.prototype.releasePointerCapture=()=>{};HTMLElement.prototype.hasPointerCapture=()=>false;
HTMLDialogElement.prototype.showModal=function(){this.open=true};HTMLDialogElement.prototype.close=function(){this.open=false};
await import('./scenarios.mjs');
`,
  );
  execFileSync(process.execPath, [path.join(temp, "setup.mjs")], {
    stdio: "inherit",
    timeout: 60000,
  });
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
