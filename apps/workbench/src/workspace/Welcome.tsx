import {
  CircuitBoard,
  FilePlus2,
  FolderOpen,
  RefreshCw,
  X,
} from "lucide-react";
import { useFiles, useNotices, useShell } from "../app/hooks";
import { useWorkbench } from "../app/provider";
import { bindingLabel } from "../shared/shortcuts";
import "./Welcome.css";

/** Start a circuit immediately, or return to a project kept by the host. */
export function Welcome() {
  const { workspace } = useWorkbench().actions;
  const folder = useFiles((state) => state.folder);
  const projects = useFiles((state) => state.recentProjects);
  const loading = useFiles((state) => state.recentLoading);
  const error = useFiles((state) => state.recentError);
  const pending = useShell((state) => Boolean(state.pending));
  const onError = useNotices((state) => state.onError);
  return (
    <div className="welcome">
      <div className={`welcome-content${folder ? " welcome-in-project" : ""}`}>
        <header className="welcome-heading">
          <p className="welcome-eyebrow">
            {folder ? "当前项目" : "电路设计与仿真"}
          </p>
          <h1>{folder ? folder.name : "Vibe Logisim"}</h1>
          <p>
            {folder
              ? "从左侧选择电路，或在项目中创建一个新电路。"
              : "从一个电路开始，或继续上次的设计。"}
          </p>
        </header>
        <div className="welcome-columns">
          <section
            className="welcome-start"
            aria-labelledby="welcome-start-title"
          >
            <h2 id="welcome-start-title">开始</h2>
            <button
              className="welcome-action"
              data-action="new-circuit"
              disabled={pending}
              onClick={() => void workspace.newFile()}
            >
              <FilePlus2 size={21} aria-hidden="true" />
              <span>
                <strong>新建电路</strong>
                <small>
                  {folder
                    ? "在当前项目中创建 .circ 文件"
                    : "直接进入画布，随时保存"}
                </small>
              </span>
              <kbd>{bindingLabel("Mod+N")}</kbd>
            </button>
            <button
              className="welcome-action"
              disabled={pending}
              onClick={workspace.openFile}
            >
              <CircuitBoard size={21} aria-hidden="true" />
              <span>
                <strong>打开电路…</strong>
                <small>继续编辑已有的 .circ 文件</small>
              </span>
              <kbd>{bindingLabel("Mod+O")}</kbd>
            </button>
            <button
              className="welcome-action"
              disabled={pending}
              onClick={() => void workspace.openFolder()}
            >
              <FolderOpen size={21} aria-hidden="true" />
              <span>
                <strong>{folder ? "打开其他项目…" : "打开项目文件夹…"}</strong>
                <small>一起管理电路、资料与 AI 对话</small>
              </span>
            </button>
          </section>
          {!folder && (
            <section
              className="welcome-recent"
              aria-labelledby="welcome-recent-title"
              aria-busy={loading}
            >
              <div className="welcome-section-heading">
                <h2 id="welcome-recent-title">最近项目</h2>
                <button
                  className="welcome-icon"
                  aria-label="刷新最近项目"
                  title="刷新最近项目"
                  disabled={loading || pending}
                  onClick={() => void workspace.refreshRecentProjects()}
                >
                  <RefreshCw size={15} />
                </button>
              </div>
              {error ? (
                <div className="welcome-recent-empty" role="alert">
                  <p>最近项目暂不可用</p>
                  <p>{error}</p>
                  <button
                    className="welcome-link"
                    onClick={() => void workspace.refreshRecentProjects()}
                  >
                    重新读取
                  </button>
                </div>
              ) : projects.length ? (
                <ul className="welcome-projects">
                  {projects.map((project) => (
                    <li key={project.path}>
                      <button
                        className="welcome-project"
                        title={project.path}
                        disabled={pending}
                        onClick={() =>
                          void workspace
                            .openFolderAt(project.path)
                            .catch(onError)
                        }
                      >
                        <span className="welcome-project-name">
                          {project.name}
                        </span>
                        <span className="welcome-project-path">
                          {project.path}
                        </span>
                        {!project.available && (
                          <span className="welcome-project-unavailable">
                            路径不可用 · 请检查位置或磁盘连接
                          </span>
                        )}
                      </button>
                      <button
                        className="welcome-icon welcome-forget"
                        aria-label={`从最近项目移除 ${project.name}`}
                        title="仅从列表移除，不删除文件"
                        disabled={pending}
                        onClick={() =>
                          void workspace.forgetRecentProject(project.path)
                        }
                      >
                        <X size={15} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="welcome-recent-empty" role="status">
                  <p>{loading ? "正在读取最近项目…" : "还没有打开过项目"}</p>
                  {!loading && (
                    <p>
                      打开过的项目文件夹会显示在这里，
                      <br />
                      下次可以一键继续。
                    </p>
                  )}
                </div>
              )}
            </section>
          )}
        </div>
        <footer className="welcome-footer">
          {folder
            ? "项目中的文件保存在本机。"
            : "只想画一个电路？选择「新建电路」即可，无需先创建文件夹。"}
        </footer>
      </div>
    </div>
  );
}
