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
          builder.onLoad({ filter: /\/lib\/transport\.ts$/ }, () => ({
            contents:
              "export const command=(v)=>globalThis.__command(v);export const desktop=()=>false;export const openPath=async()=>null;export const savePath=async()=>null;",
          }));
          builder.onLoad({ filter: /\/lib\/events\.ts$/ }, () => ({
            contents:
              "export const subscribeEvents=(fn)=>globalThis.__subscribe(fn);",
          }));
          builder.onLoad({ filter: /\/components\/FilePreview\.tsx$/ }, () => ({
            contents: "export const FilePreview=()=>null;",
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
Object.assign(globalThis,{window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,HTMLTextAreaElement:dom.window.HTMLTextAreaElement,HTMLDialogElement:dom.window.HTMLDialogElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,KeyboardEvent:dom.window.KeyboardEvent,devicePixelRatio:1,IS_REACT_ACT_ENVIRONMENT:true,requestAnimationFrame:(fn)=>setTimeout(fn,0)});
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
globalThis.ResizeObserver=class{constructor(fn){this.fn=fn}observe(){this.fn([{contentRect:{width:600,height:400}}])}disconnect(){}};
HTMLElement.prototype.setPointerCapture=()=>{};HTMLElement.prototype.releasePointerCapture=()=>{};HTMLElement.prototype.hasPointerCapture=()=>false;
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
