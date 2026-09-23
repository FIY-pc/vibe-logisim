'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {readProvider,writeProvider}=require('./provider-config.cjs');

test('provider mirror preserves the native model catalog cache',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-provider-')),source=root+'/source';
 fs.mkdirSync(source);fs.writeFileSync(source+'/models.json','{"models":[]}');
 fs.writeFileSync(source+'/config.toml',[
   'model_provider = "custom"',
   'model = "gpt-6-astra"',
   'model_catalog_json = "models.json"',
   'model_reasoning_effort = "max"',
   'service_tier = "fast"',
   'personality = "pragmatic"',
   'model_verbosity = "low"',
   'disable_response_storage = true',
   '[model_providers.custom]',
   'name = "OpenAI"',
   'base_url = "https://example.invalid/v1"',
 ].join('\n')+'\n');
 const settings=readProvider(source+'/config.toml',{});
 const target=root+'/target';fs.mkdirSync(target);
 const mirrored=writeProvider(source+'/config.toml',target);
 assert.equal(mirrored.modelCatalogJson,'models.json');
 assert.deepEqual(JSON.parse(fs.readFileSync(target+'/models.json','utf8')),{models:[]});
 assert.match(fs.readFileSync(target+'/config.toml','utf8'),/model_catalog_json = "models\.json"/);
 assert.match(fs.readFileSync(target+'/config.toml','utf8'),/service_tier = "fast"/);
 assert.match(fs.readFileSync(target+'/config.toml','utf8'),/personality = "pragmatic"/);
 assert.match(fs.readFileSync(target+'/config.toml','utf8'),/model_verbosity = "low"/);
 // Codex 0.153.x --strict-config rejects this legacy key; mirroring it made
 // the embedded app-server exit before initialize, killing the AI panel.
 assert.doesNotMatch(fs.readFileSync(target+'/config.toml','utf8'),/disable_response_storage/);
 assert.equal(settings.model,'gpt-6-astra');
});
