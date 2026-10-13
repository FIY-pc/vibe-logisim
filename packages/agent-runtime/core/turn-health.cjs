"use strict";

// A transport retry does not finish a turn or invalidate an already saved candidate.
class TurnHealth {
  constructor() { this.value = null; }
  clear() { const changed = this.value !== null; this.value = null; return changed; }
  retry(turnId, message) {
    const previous = this.value;
    this.value = {phase:"retrying",turnId,message:String(message),
      attempts:previous?.turnId===turnId ? previous.attempts+1 : 1};
  }
  finish(turnId, status, message) {
    if (status === "completed") this.clear();
    else this.value = {phase:status==="interrupted" ? "interrupted" : "failed",turnId,
      message:message || (status==="interrupted" ? "回答已停止" : "这次回答没有完成"),attempts:0};
  }
  snapshot() { return this.value ? {...this.value} : null; }
}
module.exports = {TurnHealth};
