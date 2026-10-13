import { useEffect, useState } from "react";
import type { VerificationRecord } from "../lib/reviewTypes";
const status = {
  passed: "符合预期",
  failed: "不符预期",
  unchecked: "未指定预期",
};
const valueText = (
  value: { bits: string; value: number | null } | undefined,
) =>
  value
    ? value.value === null
      ? value.bits || "未知"
      : String(value.value)
    : "—";
export function VerificationRecords({
  records,
  circuit,
  versions = {},
}: {
  records: VerificationRecord[];
  circuit: string;
  versions?: Record<string, string>;
}) {
  const available = records.filter(
    (record) => !circuit || record.circuit === circuit,
  );
  const [selected, setSelected] = useState(available[0]?.id || "");
  const [filter, setFilter] = useState("all"),
    [page, setPage] = useState(0);
  const record = available.find((item) => item.id === selected) || available[0];
  useEffect(() => {
    setPage(0);
  }, [record?.id, filter]);
  const rows = (record?.result.rows || []).filter(
    (row) => filter === "all" || row.status === filter,
  );
  const samples = record?.result.samples || [];
  const names = [
    ...new Set(samples.flatMap((sample) => Object.keys(sample.signals))),
  ];
  const count = record?.kind === "trace" ? samples.length : rows.length;
  const pages = Math.max(1, Math.ceil(count / 40)),
    current = Math.min(page, pages - 1);
  if (!record)
    return <p className="proposal-empty">这个版本没有留存的原生验证记录。</p>;
  return (
    <section className="verification-records" aria-label="原生验证记录">
      <div className="verification-toolbar">
        <select
          aria-label="选择运行记录"
          value={record.id}
          onChange={(event) => setSelected(event.target.value)}
        >
          {available.map((item) => (
            <option key={item.id} value={item.id}>
              {versions[item.revision] ? `${versions[item.revision]} · ` : ""}
              {item.kind === "vectors" ? "输入输出检查" : "时钟记录"} ·{" "}
              {new Date(item.createdAt).toLocaleString()}
            </option>
          ))}
        </select>
        {record.kind === "vectors" && (
          <select
            aria-label="筛选检查结果"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="all">全部结果</option>
            <option value="failed">不符预期</option>
            <option value="unchecked">未指定预期</option>
          </select>
        )}
      </div>
      <div className="verification-summary">
        {record.kind === "vectors" ? (
          <>
            <span>{record.result.passed || 0} 组符合预期</span>
            <span>{record.result.failed || 0} 组不符</span>
            <span>{record.result.unchecked || 0} 组未指定预期</span>
          </>
        ) : (
          <span>
            {record.result.completed ? "已完成" : "未完成"} · {samples.length}{" "}
            个采样
          </span>
        )}
      </div>
      {!record.dependenciesVerified && (
        <p className="proposal-warning" role="status">
          外部依赖未完全核验，这份记录不能证明当前依赖下的行为。
        </p>
      )}
      <details className="verification-runtime">
        <summary>运行时</summary>
        <dl>
          {Object.entries(record.runtime).map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </details>
      <div className="verification-results">
        {record.kind === "vectors" ? (
          rows.slice(current * 40, current * 40 + 40).map((row) => (
            <details
              key={row.index}
              className="vector-result"
              data-status={row.status}
            >
              <summary>
                输入 {row.index + 1} · {status[row.status]}
                {row.oscillating ? " · 振荡" : ""}
              </summary>
              <table>
                <thead>
                  <tr>
                    <th>输入</th>
                    <th>预期输出</th>
                    <th>实际输出</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      {Object.entries(row.inputs).map(([key, value]) => (
                        <div key={key}>
                          {key} = {value}
                        </div>
                      ))}
                    </td>
                    <td>
                      {Object.entries(row.expected).map(([key, value]) => (
                        <div key={key}>
                          {key} = {value}
                        </div>
                      ))}
                    </td>
                    <td>
                      {Object.entries(row.outputs).map(([key, value]) => (
                        <div key={key}>
                          {key} = {valueText(value)}
                        </div>
                      ))}
                    </td>
                  </tr>
                </tbody>
              </table>
            </details>
          ))
        ) : (
          <table className="verification-trace">
            <thead>
              <tr>
                <th>时钟步</th>
                {names.map((name) => (
                  <th key={name}>{name}</th>
                ))}
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {samples
                .slice(current * 40, current * 40 + 40)
                .map((sample, i) => (
                  <tr key={i}>
                    <th>{sample.tick}</th>
                    {names.map((name) => (
                      <td key={name}>{valueText(sample.signals[name])}</td>
                    ))}
                    <td>{sample.oscillating ? "振荡" : ""}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
        {!count && <p>没有符合筛选条件的结果。</p>}
      </div>
      {pages > 1 && (
        <footer>
          <button disabled={current === 0} onClick={() => setPage(current - 1)}>
            上一页
          </button>
          <span>
            {current + 1} / {pages}
          </span>
          <button
            disabled={current === pages - 1}
            onClick={() => setPage(current + 1)}
          >
            下一页
          </button>
        </footer>
      )}
    </section>
  );
}
