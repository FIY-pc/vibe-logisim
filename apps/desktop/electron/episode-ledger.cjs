'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// The ledger is evaluation infrastructure, not a second agent workflow. It
// records enough bounded metadata to compare episodes without persisting user
// prompts, command bodies, circuit output, credentials, or model responses.
const POSITIVE_CLAIM = /通过|成功|完成|正确|可用|works?\b|pass(?:ed)?\b|correct\b|done\b/i;

function digest(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonemptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function boundedTextMeta(value) {
  if (typeof value !== 'string') return { chars: 0, sha256: digest('') };
  return { chars: value.length, sha256: digest(value) };
}

function identity(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const key of [
    'projectId', 'folderId', 'revisionId', 'circuit', 'candidateId',
    'artifactSha256', 'runtimeProfileId', 'threadId', 'turnId', 'callId',
  ]) {
    if (typeof value[key] === 'string' || value[key] === null) result[key] = value[key];
  }
  return Object.keys(result).length ? result : null;
}

function usage(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const key of [
    'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens',
    'totalTokens', 'lastInputTokens', 'lastOutputTokens', 'lastReasoningOutputTokens',
  ]) {
    const number = finiteNumber(value[key]);
    if (number !== null) result[key] = number;
  }
  if (value.last && typeof value.last === 'object') {
    const last = usage(value.last);
    if (last) result.last = last;
  }
  if (value.total && typeof value.total === 'object') {
    const total = usage(value.total);
    if (total) result.total = total;
  }
  return Object.keys(result).length ? result : null;
}

function eventTime(at) {
  if (typeof at === 'number' && Number.isFinite(at)) return at;
  if (typeof at === 'string' && !Number.isNaN(Date.parse(at))) return Date.parse(at);
  return Date.now();
}

function safeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const allowed = [
    'replicate', 'seed', 'fixtureId', 'fixtureSha256', 'oracleId',
    'oracleVersion', 'runtimeVersion', 'runnerVersion', 'taskVariant',
  ];
  const result = {};
  for (const key of allowed) {
    const candidate = value[key];
    if (typeof candidate === 'string' || typeof candidate === 'number' || typeof candidate === 'boolean') {
      result[key] = candidate;
    }
  }
  return result;
}

class EpisodeLedger {
  constructor({
    episodeId = `episode-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    taskId = null,
    condition = null,
    model = null,
    effort = null,
    initialArtifactSha256 = null,
    metadata = null,
  } = {}) {
    this.episodeId = String(episodeId);
    this.taskId = taskId == null ? null : String(taskId);
    this.condition = condition == null ? null : String(condition);
    this.model = model == null ? null : String(model);
    this.effort = effort == null ? null : String(effort);
    this.initialArtifactSha256 = initialArtifactSha256 || null;
    this.metadata = safeMetadata(metadata);
    this.startedAt = Date.now();
    this.finishedAt = null;
    this.events = [];
    this.activities = new Map();
    this.items = new Map();
    this.turns = new Map();
    this.evidence = [];
    this.claims = [];
    this.usageSamples = [];
    this.humanInterventions = [];
    this.circuitChanges = 0;
    this.blockedRequests = 0;
    this.hostErrors = 0;
    this.final = null;
  }

  record(channel, payload, at = Date.now()) {
    if (!payload || typeof payload !== 'object') return null;
    const timestamp = eventTime(at);
    if (channel === 'telemetry') return this.#recordTelemetry(payload, timestamp);
    if (channel !== 'event') throw new TypeError('Episode channel must be event or telemetry.');
    return this.#recordEvent(payload, timestamp);
  }

  attach(emitter) {
    if (!emitter || typeof emitter.on !== 'function' || typeof emitter.off !== 'function') {
      throw new TypeError('Episode source must be an EventEmitter.');
    }
    const onEvent = event => this.record('event', event);
    const onTelemetry = event => this.record('telemetry', event);
    emitter.on('event', onEvent);
    emitter.on('telemetry', onTelemetry);
    return () => {
      emitter.off('event', onEvent);
      emitter.off('telemetry', onTelemetry);
    };
  }

  markHumanIntervention(kind = 'manual', at = Date.now()) {
    const entry = { at: eventTime(at), kind: String(kind) };
    this.humanInterventions.push(entry);
    this.events.push({ at: entry.at, channel: 'human', type: 'intervention', kind: entry.kind });
    return entry;
  }

  finalize({ outcome = null, artifact = null, oracle = null } = {}, at = Date.now()) {
    this.finishedAt = eventTime(at);
    this.final = {
      outcome: outcome == null ? null : String(outcome),
      artifact: artifact && typeof artifact === 'object' ? {
        sha256: artifact.sha256 || artifact.artifactSha256 || null,
        changed: this.initialArtifactSha256 && (artifact.sha256 || artifact.artifactSha256)
          ? this.initialArtifactSha256 !== (artifact.sha256 || artifact.artifactSha256)
          : null,
      } : null,
      oracle: oracle && typeof oracle === 'object' ? {
        status: oracle.status || null,
        authority: oracle.authority || 'external',
        id: oracle.id || null,
        durationMs: finiteNumber(oracle.durationMs),
      } : null,
    };
    return this.snapshot();
  }

  metrics() {
    const activities = [...this.activities.values()];
    const completed = activities.filter(item => item.status && item.status !== 'running');
    const toolActivities = completed.filter(item => ['command', 'tool', 'web'].includes(item.kind));
    const circuitActivities = toolActivities.filter(item => item.kind === 'tool' && item.activityKey?.startsWith('circuit:'));
    const visualActivities = circuitActivities.filter(item => item.activityKey === 'circuit:render_circuit');
    const nativeRuns = circuitActivities.filter(item => item.status === 'completed' &&
      ['circuit:simulate_circuit', 'circuit:trace_circuit', 'circuit:evaluate_circuit'].includes(item.activityKey));
    const failed = toolActivities.filter(item => item.status === 'failed');
    const recovery = activities.filter(item => item.status === 'completed' &&
      activities.some(failure => failure.activityKey === item.activityKey && failure.failedAt !== null && failure.failedAt < item.lastAt)).length;
    const grounded = this.evidence.find(item => item.groundedAt !== null);
    const positiveClaim = this.claims.some(item => item.positive);
    const passedEvidence = this.evidence.some(item => item.feedbackStatus === 'passed');
    const verdictEvidence = this.evidence.filter(item => ['passed', 'failed'].includes(item.feedbackStatus));
    const visualEvidence = this.evidence.filter(item => item.run?.kind === 'render');
    const tokenTotals = this.usageSamples.map(sample => sample.usage?.total || sample.usage).filter(Boolean);
    const lastUsage = tokenTotals.at(-1) || null;
    const peakInputTokens = this.usageSamples.reduce((peak, sample) => {
      const value = sample.usage?.last?.inputTokens ?? sample.usage?.lastInputTokens ?? null;
      return value === null ? peak : Math.max(peak, value);
    }, 0);
    const oracleStatus = this.final?.oracle?.status || null;
    return {
      taskSuccess: oracleStatus === 'passed' ? true : oracleStatus === 'failed' ? false : null,
      completedAndVerified: oracleStatus === 'passed' && this.final?.outcome === 'completed',
      timeToFirstGroundedEvidenceMs: grounded ? grounded.at - this.startedAt : null,
      toolCalls: toolActivities.length,
      circuitToolCalls: circuitActivities.length,
      circuitToolFailures: circuitActivities.filter(item => item.status === 'failed').length,
      visualObservationCalls: visualActivities.length,
      visualObservationFailures: visualActivities.filter(item => item.status === 'failed').length,
      visualEvidenceCount: visualEvidence.length,
      commandFailures: toolActivities.filter(item => item.kind === 'command' && item.status === 'failed').length,
      fileChangeEvents: completed.filter(item => item.kind === 'file').length,
      nativeRunCalls: nativeRuns.length,
      // Exit/status cannot tell apart invalid arguments, failed assertions,
      // informational CLI exits or intentional process termination.
      failedCalls: failed.length,
      laterSuccessesOfSameActivity: recovery,
      artifactChanges: this.final?.artifact?.changed ?? (this.circuitChanges > 0 ? true : null),
      verificationCount: verdictEvidence.length,
      humanInterventions: this.humanInterventions.length,
      // Keywords cannot distinguish a promise, negation, or a claim about
      // another artifact. Semantic alignment needs an explicit review.
      claimEvidenceAlignment: 'not-assessed',
      positiveClaimHeuristic: positiveClaim,
      observedPassedFeedback: passedEvidence,
      turnCount: this.turns.size,
      circuitChanges: this.circuitChanges,
      blockedRequests: this.blockedRequests,
      hostErrors: this.hostErrors,
      finalOracleStatus: oracleStatus,
      tokenUsage: lastUsage,
      peakRequestInputTokens: peakInputTokens || null,
    };
  }

  snapshot() {
    return {
      schema: 'vibe-logisim.episode/v2',
      episodeId: this.episodeId,
      taskId: this.taskId,
      condition: this.condition,
      model: this.model,
      effort: this.effort,
      startedAt: new Date(this.startedAt).toISOString(),
      finishedAt: this.finishedAt ? new Date(this.finishedAt).toISOString() : null,
      initialArtifactSha256: this.initialArtifactSha256,
      metadata: this.metadata,
      metrics: this.metrics(),
      final: this.final,
      events: this.events,
    };
  }

  write(filePath) {
    const target = path.resolve(filePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.snapshot(), null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, target);
    return target;
  }

  #recordEvent(event, at) {
    const type = String(event.type || 'unknown');
    const base = { at, channel: 'event', type };
    switch (type) {
      case 'user-message': {
        const text = boundedTextMeta(event.text);
        this.events.push({...base, id: event.id || null, text, context: identity(event.context)});
        break;
      }
      case 'assistant-completed': {
        const text = boundedTextMeta(event.text);
        const claim = { at, positive: event.phase !== 'commentary' && POSITIVE_CLAIM.test(event.text || ''), text };
        this.claims.push(claim);
        this.events.push({...base, itemId: event.itemId || null, text, positive: claim.positive});
        break;
      }
      case 'turn-started':
        this.turns.set(String(event.turnId || `turn-${this.turns.size + 1}`), { startedAt: at, completedAt: null, status: 'running' });
        this.events.push({...base, turnId: event.turnId || null});
        break;
      case 'turn-completed': {
        const id = String(event.turnId || `turn-${this.turns.size + 1}`);
        const turn = this.turns.get(id) || { startedAt: null };
        turn.completedAt = at;
        turn.status = event.status || 'unknown';
        this.turns.set(id, turn);
        this.events.push({...base, turnId: event.turnId || null, status: event.status || null, error: boundedTextMeta(event.error).sha256});
        break;
      }
      case 'activity': {
        const id = String(event.itemId || `${event.activityKey || 'activity'}-${this.activities.size + 1}`);
        const prior = this.activities.get(id) || {
          itemId: id, activityKey: event.activityKey || null, kind: event.kind || 'tool',
          label: event.label || null, firstAt: at, failedAt: null, recovered: false,
        };
        const status = event.status || 'unknown';
        if (status === 'failed') prior.failedAt = at;
        if (prior.failedAt && status === 'completed') prior.recovered = true;
        Object.assign(prior, {
          activityKey: event.activityKey || prior.activityKey,
          kind: event.kind || prior.kind,
          label: event.label || prior.label,
          lastAt: at,
          status,
          detail: boundedTextMeta(event.detail),
        });
        this.activities.set(id, prior);
        this.events.push({...base, itemId: id, kind: prior.kind, activityKey: prior.activityKey, status, label: prior.label});
        break;
      }
      case 'harness-result': {
        const binding = identity(event.binding || event.session);
        const run = event.run && typeof event.run === 'object' ? {
          id: event.run.id || null, kind: event.run.kind || null, label: event.run.label || null,
          authority: event.run.authority || null,
        } : null;
        const feedbackStatus = event.feedback?.status || null;
        const grounded = nonemptyString(run?.id) &&
          (nonemptyString(binding?.revisionId) || nonemptyString(binding?.artifactSha256));
        const evidence = {at, groundedAt: grounded ? at : null, binding, run, feedbackStatus};
        this.evidence.push(evidence);
        this.events.push({...base, itemId: event.itemId || null, turnId: event.turnId || null,
          binding, run, feedbackStatus});
        break;
      }
      case 'circuit-change':
        this.circuitChanges += 1;
        this.events.push({...base, applied: event.applied === true, candidateId: event.candidate?.id || null});
        break;
      case 'blocked-request':
        this.blockedRequests += 1;
        this.events.push({...base, method: event.method || null, scope: identity(event.scope)});
        break;
      case 'error':
        this.hostErrors += 1;
        this.events.push({...base, message: boundedTextMeta(event.message)});
        break;
      default:
        this.events.push(base);
    }
    return this.events.at(-1);
  }

  #recordTelemetry(event, at) {
    const method = String(event.method || 'unknown');
    const params = event.params && typeof event.params === 'object' ? event.params : {};
    if (method === 'thread/tokenUsage/updated') {
      const sample = {at, method, turnId: params.turnId || null, usage: usage(params.tokenUsage)};
      this.usageSamples.push(sample);
      this.events.push({...sample, channel: 'telemetry'});
      return sample;
    }
    if (method === 'item/completed') {
      const item = params.item && typeof params.item === 'object' ? params.item : {};
      const entry = {
        at, channel: 'telemetry', method, turnId: params.turnId || null,
        itemId: item.id || null, itemType: item.type || null,
        tool: item.tool || null, success: typeof item.success === 'boolean' ? item.success
          : item.status === 'completed' ? true : item.status === 'failed' ? false : null,
        status: item.status || null, exitCode: finiteNumber(item.exitCode),
        durationMs: finiteNumber(item.durationMs),
      };
      this.items.set(String(item.id || `${method}-${this.items.size + 1}`), entry);
      this.events.push(entry);
      return entry;
    }
    if (method === 'turn/started' || method === 'turn/completed') {
      this.events.push({at, channel: 'telemetry', method, turnId: params.turn?.id || params.turnId || null,
        status: params.turn?.status || null});
      return this.events.at(-1);
    }
    this.events.push({at, channel: 'telemetry', method});
    return this.events.at(-1);
  }
}

module.exports = {EpisodeLedger, digest};
