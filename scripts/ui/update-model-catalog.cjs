'use strict';
// Explicit maintenance command, never run as part of startup or packaging.
// Usage: node scripts/ui/update-model-catalog.cjs [downloaded-models.dev-api.json]
const fs=require('node:fs/promises'),path=require('node:path');
const {compact,URL,VERSION}=require('../../apps/desktop/electron/model-catalog.cjs');
(async()=>{
 const text=process.argv[2]?await fs.readFile(process.argv[2],'utf8'):await (async()=>{
   const response=await fetch(URL,{signal:AbortSignal.timeout(30000),redirect:'error'});
   if(!response.ok)throw new Error(`Catalog HTTP ${response.status}`);return response.text();
 })();
 const snapshot={version:VERSION,source:URL,license:'MIT',retrievedAt:new Date().toISOString().slice(0,10),providers:compact(JSON.parse(text))};
 const target=path.resolve(__dirname,'../../apps/desktop/electron/model-catalog.snapshot.json');
 await fs.writeFile(target,JSON.stringify(snapshot));
 console.log(`Updated ${Object.keys(snapshot.providers).length} provider catalogs (${Buffer.byteLength(JSON.stringify(snapshot))} bytes)`);
})().catch(error=>{console.error(error.message);process.exitCode=1;});
