import { tip } from "../shared/Tooltips";

/** Context usage from the runtime's status snapshot. */
export interface ContextUsage {
  tokens: number;
  contextWindow: number;
  source: "usage" | "estimate";
  compactAt: number;
  status: "ready" | "compacting";
  compactions: number;
}

const tokens = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });

export function ContextUsageRing({ usage }: { usage?: ContextUsage | null }) {
  const known =
    usage != null &&
    Number.isFinite(usage.tokens) &&
    usage.tokens >= 0 &&
    Number.isFinite(usage.contextWindow) &&
    usage.contextWindow > 0;
  // The compaction threshold is a separate detail, never the denominator.
  const ratio = known ? usage.tokens / usage.contextWindow : null;
  const percent = ratio === null ? null : Math.floor(ratio * 100);
  const compacting = usage?.status === "compacting";
  const summary =
    (percent === null ? "上下文用量未知" : `上下文已用 ${percent}%`) +
    (compacting ? " · 正在压缩…" : "");
  const details = [
    summary,
    known
      ? `${tokens.format(usage.tokens)} / ${tokens.format(usage.contextWindow)} tokens${usage.source === "estimate" ? "（估算）" : ""}`
      : "暂无可用的上下文用量数据",
    usage && Number.isFinite(usage.compactAt) && usage.compactAt > 0
      ? `自动压缩阈值：${tokens.format(usage.compactAt)} tokens`
      : null,
    usage && usage.compactions > 0 ? `已压缩 ${usage.compactions} 次` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <span
      className={
        "context-usage" +
        (ratio !== null && ratio >= 0.75 ? " is-high" : "") +
        (ratio === null ? " is-unknown" : "") +
        (compacting ? " is-compacting" : "")
      }
      tabIndex={0}
      role={percent === null ? "img" : "meter"}
      aria-label={percent === null ? summary : "上下文用量"}
      aria-valuemin={percent === null ? undefined : 0}
      aria-valuemax={percent === null ? undefined : 100}
      aria-valuenow={percent === null ? undefined : Math.min(100, percent)}
      aria-valuetext={percent === null ? undefined : summary}
      {...tip(details)}
    >
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
        <circle className="context-usage-track" cx="10" cy="10" r="7.5" />
        {ratio !== null && (
          <circle
            className="context-usage-fill"
            cx="10"
            cy="10"
            r="7.5"
            pathLength="100"
            strokeDasharray={`${Math.min(1, ratio) * 100} 100`}
            transform="rotate(-90 10 10)"
          />
        )}
        {compacting && (
          <circle className="context-usage-pulse" cx="10" cy="10" r="2" />
        )}
      </svg>
    </span>
  );
}
