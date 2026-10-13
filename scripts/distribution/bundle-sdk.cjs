'use strict';
const fs=require('node:fs'),path=require('node:path');
const desktop=path.resolve(__dirname,'../../apps/desktop');
const source=path.resolve(desktop,'../../packages/agent-runtime/core/builtin-sdk.mjs');
const {build}=require(path.join(desktop,'node_modules/esbuild'));
async function bundle(app) {
  const output=path.join(app,'runtime/core/builtin-sdk.mjs');
  const result=await build({absWorkingDir:desktop,entryPoints:[source],outfile:output,
    bundle:true,platform:'node',format:'esm',target:'node22',minify:true,keepNames:true,metafile:true,legalComments:'inline',
    banner:{js:'import {createRequire as __createRequire} from "node:module"; const require=__createRequire(import.meta.url);'},
    // The shared source is outside apps/desktop. Resolve its SDK imports from
    // this distribution's own locked installation, including in a monorepo.
    plugins:[{name:'desktop-sdk-dependencies',setup(builder){
      builder.onResolve({filter:/^@earendil-works\//},args=>args.importer===source
        ? builder.resolve(args.path,{kind:args.kind,resolveDir:desktop}) : undefined);
    }}],
  });
  await fs.promises.mkdir(path.join(app,'electron'),{recursive:true});
  await fs.promises.writeFile(path.join(app,'electron/builtin-sdk.mjs'),
    "export * from '../runtime/core/builtin-sdk.mjs';\n");
  // Preserve upstream licenses even when their code is reduced by tree shaking.
  const packages=new Set();
  for(const file of Object.keys(result.metafile.inputs)) {
    if(!file.includes('node_modules/'))continue;
    let dir=path.dirname(path.resolve(desktop,file));
    while(dir.startsWith(desktop)&&!fs.existsSync(path.join(dir,'package.json')))dir=path.dirname(dir);
    if(dir.startsWith(desktop))packages.add(dir);
  }
  const notices=path.join(app,'../third-party/node');fs.mkdirSync(notices,{recursive:true});
  const index=[];
  for(const dir of [...packages].sort()) {
    const pkg=JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8'));
    const dest=path.join(notices,pkg.name+'@'+pkg.version);fs.mkdirSync(dest,{recursive:true});
    index.push({name:pkg.name,version:pkg.version,license:pkg.license,repository:pkg.repository});
    for(const name of fs.readdirSync(dir))if(/^(licen[sc]e|copying|notice|readme)/i.test(name)&&fs.statSync(path.join(dir,name)).isFile())fs.copyFileSync(path.join(dir,name),path.join(dest,name));
  }
  fs.writeFileSync(path.join(notices,'packages.json'),JSON.stringify(index,null,2));
  console.log(`built-in SDK: ${fs.statSync(output).size} bytes; ${packages.size} dependency notices`);
}
if(require.main===module)bundle(path.resolve(process.argv[2])).catch(error=>{console.error(error);process.exitCode=1;});
module.exports={bundle};
