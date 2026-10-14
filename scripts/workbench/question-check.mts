/** Real Chat DOM and dispatch/backend code, with only native stdio replayed. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { build, transform } from "esbuild";
const root = path.resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const directory = await mkdtemp(path.join(tmpdir(), "vibe-question-check-"));
try {
  const source = await readFile(
    path.join(root, "packages/agent-runtime/src/worker.mts"),
    "utf8",
  );
  const start = source.indexOf("async function dispatch(");
  const end = source.indexOf("// A bind or turn startup", start);
  if (start < 0 || end < start)
    throw new Error("Worker dispatch boundary changed");
  // Execute the current worker's dispatch function against the actual shared
  // runtime adapter. No reimplementation of its argument mapping lives here.
  const dispatch = await transform(source.slice(start, end), { loader: "ts" });
  await build({
    entryPoints: [path.join(root, "scripts/workbench/ui/questions.tsx")],
    bundle: true,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    outfile: path.join(directory, "questions.mjs"),
    nodePaths: [
      path.join(root, "apps/workbench/node_modules"),
      path.join(root, "node_modules"),
    ],
    plugins: [
      {
        name: "host-fixture",
        setup(builder) {
          builder.onLoad({ filter: /\/lib\/transport\.ts$/ }, () => ({
            contents:
              "export const command=(r)=>globalThis.__command(r);export const desktop=()=>false;export const openPath=async()=>null;",
          }));
          builder.onLoad({ filter: /\/lib\/events\.ts$/ }, () => ({
            contents:
              "export const subscribeEvents=(fn)=>globalThis.__subscribe(fn);",
          }));
        },
      },
    ],
  });
  const core = path.join(root, "packages/agent-runtime/core");
  await writeFile(
    path.join(directory, "setup.mjs"),
    `
import {createRequire,registerHooks,syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {JSDOM} from ${JSON.stringify(require.resolve("jsdom"))};
const require=createRequire(import.meta.url);
const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,HTMLDialogElement:dom.window.HTMLDialogElement,FormData:dom.window.FormData,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true});
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
// JSDOM has no layout engine; question dispatch does not need resize delivery.
class FixtureResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.assign(globalThis,{ResizeObserver:FixtureResizeObserver});
Object.assign(dom.window,{ResizeObserver:FixtureResizeObserver});
const nativeWrites=[];
const child=new EventEmitter();
Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),pid:null,exitCode:null,signalCode:null});
child.kill=()=>{setImmediate(()=>child.emit('exit',0,null));return true};
child.stdin.on('finish',()=>{child.exitCode=0;child.emit('exit',0,null);child.stdout.end();child.stderr.end()});
child.stdin.on('data',chunk=>{
 const message=JSON.parse(String(chunk));nativeWrites.push(message);
 if(!message.method)return;
 let result;
 if(message.method==='initialize'||message.method==='turn/interrupt')result={};
 else if(message.method==='initialized')return;
 else if(message.method==='account/read')result={account:null,requiresOpenaiAuth:false};
 else if(message.method==='config/read')result={config:{}};
 else if(message.method==='model/list')result={data:[]};
 else throw new Error('Unexpected native request '+message.method);
 child.stdout.write(JSON.stringify({id:message.id,result})+'\\n');
});
const processTools=require('node:child_process'),originalSpawn=processTools.spawn;
const isolationUrl=${JSON.stringify(pathToFileURL(path.join(core, "agent-process.mts")).href)};
const hooks=registerHooks({load(url,context,nextLoad){
 if(url!==isolationUrl)return nextLoad(url,context);
 return {format:'module',shortCircuit:true,source:${JSON.stringify(`
 export const isolatedSpawn=()=>({command:'synthetic-stdio',args:[],cwd:${JSON.stringify(directory)},env:{}});
 export const resolveExecutable=(command)=>command;
 export const isolationKind=()=>"systemd-linux";
 `)}};
}});
processTools.spawn=()=>child;
syncBuiltinESMExports();
const {AgentRuntime}=await import(${JSON.stringify(pathToFileURL(path.join(core, "agent-runtime.mts")).href)});
hooks.deregister();
const runtime=new AgentRuntime({workDir:${JSON.stringify(directory)},profileDir:${JSON.stringify(path.join(directory, "profile"))},ownProfile:true});
runtime.kind='codex';const backend=runtime.backends.codex;
backend.resolveNetwork=async()=>({proxyUrl:null});
try{await backend.start()}finally{processTools.spawn=originalSpawn;syncBuiltinESMExports()}
const dispatch=new Function('backend',${JSON.stringify(dispatch.code + ";return dispatch;")})(runtime);
globalThis.__questionFixture={backend,nativeWrites,dispatch,notify:(message)=>child.stdout.write(JSON.stringify(message)+'\\n')};
try{await import('./questions.mjs')}finally{await backend.stop();dom.window.close()}
// React's browser scheduler retains MessagePorts under Node after unmount.
process.exit(0);
`,
  );
  execFileSync(process.execPath, [path.join(directory, "setup.mjs")], {
    stdio: "inherit",
    timeout: 30_000,
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}
