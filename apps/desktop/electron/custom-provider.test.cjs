'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {saveCustomProvider, readCustomProvider, clearCustomProvider, validate, CATALOG_FILE, PROVIDER_FILE} = require('./custom-provider.cjs');
const {readProvider} = require('./provider-config.cjs');

test('a student endpoint becomes provider.toml plus a strict-config-safe catalog, key stays out of config.toml', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-custom-provider-'));
  const visible = saveCustomProvider(profile, {baseUrl: 'api.deepseek.com/v1/', apiKey: 'sk-abcdefghijklmnop', model: 'deepseek-chat'});
  assert.equal(visible.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(visible.model, 'deepseek-chat');
  assert.equal(visible.apiKey, undefined);
  assert.equal(visible.apiKeyHint, 'sk-a••••mnop');
  const catalog = JSON.parse(fs.readFileSync(path.join(profile, CATALOG_FILE), 'utf8'));
  assert.equal(catalog.models[0].slug, 'deepseek-chat');
  assert.deepEqual(catalog.models[0].supported_reasoning_levels.map(l => l.effort), ['low', 'medium', 'high']);
  assert.ok(catalog.models[0].model_messages.instructions_template.length > 100);
  // provider-config mirrors it the same way it mirrors ~/.codex/config.toml
  const mirrored = readProvider(path.join(profile, PROVIDER_FILE), {}, {profileDir: profile});
  assert.equal(mirrored.model, 'deepseek-chat');
  assert.equal(mirrored.modelCatalogJson, CATALOG_FILE);
  assert.doesNotMatch(mirrored.toml, /sk-abcdefghijklmnop/);
  assert.match(mirrored.toml, /env_key = "VIBE_LOGISIM_PROVIDER_TOKEN"/);
  assert.match(mirrored.toml, /wire_api = "responses"/);
  assert.equal(mirrored.environment.VIBE_LOGISIM_PROVIDER_TOKEN, 'sk-abcdefghijklmnop');
  assert.deepEqual(readCustomProvider(profile), {name: '自定义接口', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', effort: 'medium', contextWindow: 256000, apiKeyHint: 'sk-a••••mnop'});
  clearCustomProvider(profile);
  assert.equal(readCustomProvider(profile), null);
  assert.equal(fs.existsSync(path.join(profile, CATALOG_FILE)), false);
});

test('invalid input is rejected before anything is written', () => {
  assert.throws(() => validate({baseUrl: '', apiKey: 'k', model: 'm'}), /接口地址/);
  assert.throws(() => validate({baseUrl: 'https://x.example/v1', apiKey: '', model: 'm'}), /密钥/);
  assert.throws(() => validate({baseUrl: 'https://x.example/v1', apiKey: 'k', model: ''}), /模型名称/);
  assert.throws(() => validate({baseUrl: 'https://x.example/v1', apiKey: 'k"\n', model: 'm'}), /密钥格式/);
  assert.throws(() => validate({baseUrl: 'https://u:p@x.example/v1', apiKey: 'k', model: 'm'}), /账号/);
  assert.equal(validate({baseUrl: 'https://x.example/v1/chat/completions', apiKey: 'k', model: 'm'}).baseUrl, 'https://x.example/v1');
});
