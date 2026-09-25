'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {saveCustomProvider, readCustomProvider, readStoredApiKey, clearCustomProvider, validate, validateEndpoint, CATALOG_FILE, PROVIDER_FILE} = require('./custom-provider.cjs');
const {readProvider} = require('./provider-config.cjs');

test('a student endpoint becomes provider.toml plus a strict-config-safe catalog, key stays out of config.toml', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-custom-provider-'));
  const visible = saveCustomProvider(profile, {baseUrl: 'api.deepseek.com/v1/', apiKey: 'sk-abcdefghijklmnop', model: 'deepseek-chat'});
  assert.equal(visible.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(visible.model, 'deepseek-chat');
  assert.equal(visible.apiKey, undefined);
  assert.equal(visible.apiKeyHint, 'sk-a••••mnop');
  assert.deepEqual(visible.models, ['deepseek-chat']);
  const catalog = JSON.parse(fs.readFileSync(path.join(profile, CATALOG_FILE), 'utf8'));
  assert.equal(catalog.models[0].slug, 'deepseek-chat');
  assert.deepEqual(catalog.models[0].supported_reasoning_levels.map(l => l.effort), ['none', 'low', 'medium', 'high']);
  assert.ok(catalog.models[0].model_messages.instructions_template.length > 100);
  // provider-config mirrors it the same way it mirrors ~/.codex/config.toml
  const mirrored = readProvider(path.join(profile, PROVIDER_FILE), {}, {profileDir: profile});
  assert.equal(mirrored.model, 'deepseek-chat');
  assert.equal(mirrored.modelCatalogJson, CATALOG_FILE);
  assert.doesNotMatch(mirrored.toml, /sk-abcdefghijklmnop/);
  assert.match(mirrored.toml, /env_key = "VIBE_LOGISIM_PROVIDER_TOKEN"/);
  assert.match(mirrored.toml, /wire_api = "responses"/);
  assert.equal(mirrored.environment.VIBE_LOGISIM_PROVIDER_TOKEN, 'sk-abcdefghijklmnop');
  assert.deepEqual(readCustomProvider(profile), {name: '自定义接口', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', effort: 'medium', contextWindow: 256000, apiKeyHint: 'sk-a••••mnop', models: ['deepseek-chat']});
  assert.equal(readStoredApiKey(profile), 'sk-abcdefghijklmnop');
  clearCustomProvider(profile);
  assert.equal(readCustomProvider(profile), null);
  assert.equal(readStoredApiKey(profile), null);
  assert.equal(fs.existsSync(path.join(profile, CATALOG_FILE)), false);
});

test('discovered models fill the catalog behind the chosen one; a blank key keeps the saved key', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-custom-provider-'));
  const first = saveCustomProvider(profile, {baseUrl: 'https://relay.example/v1', apiKey: 'sk-first-key-0123456789', model: 'gpt-5.4',
    models: ['deepseek-chat', 'gpt-5.4', 'bad id', 'claude-x', 'deepseek-chat'], effort: 'none', contextWindow: 400000});
  assert.deepEqual(first.models, ['gpt-5.4', 'deepseek-chat', 'claude-x']);
  const catalog = JSON.parse(fs.readFileSync(path.join(profile, CATALOG_FILE), 'utf8'));
  assert.deepEqual(catalog.models.map(m => [m.slug, m.priority, m.default_reasoning_level, m.context_window]), [['gpt-5.4', 1, 'none', 400000], ['deepseek-chat', 2, 'none', 400000], ['claude-x', 3, 'none', 400000]]);
  assert.match(fs.readFileSync(path.join(profile, PROVIDER_FILE), 'utf8'), /model_reasoning_effort = "none"/);
  const read = readCustomProvider(profile);
  assert.deepEqual(read.models, ['gpt-5.4', 'deepseek-chat', 'claude-x']);
  assert.equal(read.effort, 'none');
  // Re-save without retyping the key (the form leaves the field blank).
  const second = saveCustomProvider(profile, {baseUrl: 'https://relay.example/v1', apiKey: '', model: 'claude-x', models: read.models}, {storedApiKey: readStoredApiKey(profile)});
  assert.equal(second.apiKeyHint, 'sk-f••••6789');
  assert.equal(readStoredApiKey(profile), 'sk-first-key-0123456789');
  assert.deepEqual(readCustomProvider(profile).models, ['claude-x', 'gpt-5.4', 'deepseek-chat']);
  assert.equal(readProvider(path.join(profile, PROVIDER_FILE), {}, {profileDir: profile}).model, 'claude-x');
  assert.throws(() => saveCustomProvider(profile, {baseUrl: 'https://relay.example/v1', apiKey: '', model: 'x'}), /密钥/);
});

test('invalid input is rejected before anything is written', () => {
  assert.throws(() => validate({baseUrl: '', apiKey: 'k', model: 'm'}), /接口地址/);
  assert.throws(() => validate({baseUrl: 'https://x.example/v1', apiKey: '', model: 'm'}), /密钥/);
  assert.throws(() => validate({baseUrl: 'https://x.example/v1', apiKey: 'k', model: ''}), /模型名称/);
  assert.throws(() => validate({baseUrl: 'https://x.example/v1', apiKey: 'k"\n', model: 'm'}), /密钥格式/);
  assert.throws(() => validate({baseUrl: 'https://u:p@x.example/v1', apiKey: 'k', model: 'm'}), /账号/);
  assert.equal(validate({baseUrl: 'https://x.example/v1/chat/completions', apiKey: 'k', model: 'm'}).baseUrl, 'https://x.example/v1');
  assert.equal(validate({baseUrl: 'https://x.example/v1/models', apiKey: 'k', model: 'm'}).baseUrl, 'https://x.example/v1');
  assert.equal(validate({baseUrl: 'https://x.example/v1', apiKey: 'k', model: 'm', effort: 'ultra'}).effort, 'medium');
  assert.deepEqual(validateEndpoint({baseUrl: 'x.example/v1', apiKey: ''}, {storedApiKey: 'saved'}), {baseUrl: 'https://x.example/v1', apiKey: 'saved'});
});
