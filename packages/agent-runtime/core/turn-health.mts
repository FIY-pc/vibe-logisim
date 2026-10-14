// A transport retry does not finish a turn or invalidate an already saved candidate.
class TurnHealth {
  declare value: {
    phase: string;
    turnId: string;
    message: string;
    attempts: number;
  } | null;

  constructor() {
    this.value = null;
  }
  clear() {
    const changed = this.value !== null;
    this.value = null;
    return changed;
  }
  retry(turnId: string, message: string) {
    const previous = this.value;
    this.value = {
      phase: "retrying",
      turnId,
      message: String(message),
      attempts: previous?.turnId === turnId ? previous.attempts + 1 : 1,
    };
  }
  finish(turnId: string, status: string, message?: string | null) {
    if (status === "completed") this.clear();
    else
      this.value = {
        phase: status === "interrupted" ? "interrupted" : "failed",
        turnId,
        message:
          message ||
          (status === "interrupted" ? "回答已停止" : "这次回答没有完成"),
        attempts: 0,
      };
  }
  snapshot() {
    return this.value ? { ...this.value } : null;
  }
}
export { TurnHealth };
