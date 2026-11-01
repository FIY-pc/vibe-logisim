import { build } from "esbuild";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../../..");
await build({
  entryPoints: [path.join(root, "packages/showcase/demo/main.ts")],
  outfile: path.join(root, "packages/showcase/public/demo.js"),
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: true,
  legalComments: "inline",
});
console.log("Built demo with the workbench's shared circuit renderer.");
