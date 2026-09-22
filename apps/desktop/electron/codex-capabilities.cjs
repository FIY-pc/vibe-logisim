'use strict';

const {createHash} = require('node:crypto');

// The embedded Codex process has two different kinds of capability:
// Base Harness lifecycle (thread/turn/files/shell/model) and native Codex
// features that need an additional desktop or protocol host. Keep the policy
// separate from CodexBackend so enabling a feature cannot be mistaken for
// merely deleting one --disable argument.

const FEATURE_POLICY = Object.freeze({
  apps: ['disabled', 'host-unsupported', 'Vibe Logisim has no Apps host surface'],
  auth_elicitation: ['disabled', 'host-unsupported', 'the embedded host has no native auth prompt surface'],
  browser_use: ['disabled', 'host-unsupported', 'the embedded host has no browser surface'],
  browser_use_external: ['disabled', 'host-unsupported', 'the embedded host has no external browser bridge'],
  browser_use_full_cdp_access: ['disabled', 'host-unsupported', 'the embedded host has no CDP bridge'],
  computer_use: ['disabled', 'host-unsupported', 'the embedded host has no computer-control surface'],
  goals: ['disabled', 'host-unsupported', 'goal lifecycle is not projected into the desktop UI'],
  hooks: ['disabled', 'workspace-boundary', 'hooks are not part of the embedded workspace contract'],
  image_generation: ['disabled', 'host-unsupported', 'the embedded renderer does not expose image-generation actions'],
  in_app_browser: ['disabled', 'host-unsupported', 'the embedded host has no in-app browser surface'],
  multi_agent: ['disabled', 'workspace-boundary', 'child turns are not admitted through the direct workspace guard'],
  multi_agent_v2: ['disabled', 'workspace-boundary', 'child turns are not admitted through the direct workspace guard'],
  network_proxy: ['disabled', 'host-unsupported', 'the embedded host does not implement the proxy broker'],
  plugin_sharing: ['disabled', 'host-unsupported', 'plugin sharing has no embedded host contract'],
  plugins: ['disabled', 'host-unsupported', 'the embedded host does not project the Codex plugin runtime'],
  remote_plugin: ['disabled', 'host-unsupported', 'remote plugin installation has no embedded host contract'],
  shell_snapshot: ['disabled', 'workspace-boundary', 'shell state is intentionally scoped to the current turn'],
  shell_snapshot_v2: ['disabled', 'workspace-boundary', 'shell state is intentionally scoped to the current turn'],
  skill_mcp_dependency_install: ['disabled', 'workspace-boundary', 'dependency installation is not part of direct workspace admission'],
  sleep_tool: ['disabled', 'host-unsupported', 'the embedded host has no scheduled-turn surface'],
  tool_call_mcp_elicitation: ['disabled', 'host-unsupported', 'the embedded host has no MCP elicitation UI'],
  tool_suggest: ['disabled', 'host-unsupported', 'the embedded renderer has no native tool-suggestion surface'],
  workspace_dependencies: ['disabled', 'host-unsupported', 'the embedded host exposes its own bundled runtime contract'],
  memories: ['disabled', 'workspace-boundary', 'global memory is not part of the project workspace contract'],
});

const DISABLED_CODEX_FEATURES = Object.freeze(
  Object.entries(FEATURE_POLICY)
    .filter(([feature, [state]]) => state === 'disabled' && feature !== 'memories')
    .map(([feature]) => feature),
);

const THREAD_CONFIG = Object.freeze({
  ...Object.fromEntries(DISABLED_CODEX_FEATURES.map(feature => [`features.${feature}`, false])),
  'features.memories': false,
  'features.code_mode': true,
  'features.code_mode_host': true,
  web_search: 'live',
  'shell_environment_policy.inherit': 'core',
  allow_login_shell: false,
});

const BASE_CAPABILITIES = Object.freeze({
  runtime: 'codex-app-server',
  threads: 'native',
  turns: 'native',
  history: 'native',
  turnSteering: true,
  directWorkspaceEdits: true,
  filesystem: true,
  shell: true,
  webSearch: 'live',
  modelCatalog: 'native',
  dynamicTools: true,
  codeMode: true,
  workspaceIsolation: 'systemd-linux',
});

const POLICY_SIGNATURE = createHash('sha256')
  .update(JSON.stringify({featurePolicy: FEATURE_POLICY, thread: THREAD_CONFIG, base: BASE_CAPABILITIES}), 'utf8')
  .digest('hex');

function capabilitySnapshot({plugin = null, directTools = [], detail = false} = {}) {
  const report = {
    schema: 'vibe-logisim.harness/v1',
    signature: POLICY_SIGNATURE,
    base: BASE_CAPABILITIES,
    disabledFeatures: Object.keys(FEATURE_POLICY),
    enforced: {
      approval: 'never',
      sandbox: 'external-systemd',
      loginShell: false,
      modelSelection: 'native-catalog',
    },
    circuitPlugin: plugin
      ? {
        id: plugin.id || null,
        version: plugin.version || null,
        schema: plugin.schema || null,
        signature: plugin.signature || null,
        directTools: [...new Set(directTools)].sort(),
      }
      : null,
  };
  if (detail) {
    report.featurePolicy = Object.fromEntries(
      Object.entries(FEATURE_POLICY).map(([feature, [state, boundary, reason]]) => [feature, {
        state,
        boundary,
        reason,
      }]),
    );
  }
  return report;
}

module.exports = {
  BASE_CAPABILITIES,
  DISABLED_CODEX_FEATURES,
  FEATURE_POLICY,
  POLICY_SIGNATURE,
  THREAD_CONFIG,
  capabilitySnapshot,
};
