import { useMemo } from "react";
import { Popover } from "@radix-ui/themes";
import { ArrowRight, Download, ExternalLink } from "lucide-react";
import { Button, Heading } from "../design/ui";
import { keepKeys } from "../shared/layer";
import type { FeedbackController } from "./Feedback";
import { releaseHighlights } from "./releaseHighlights";

export function UpdatePopover({ feedback }: { feedback: FeedbackController }) {
  const { status } = feedback;
  const highlights = useMemo(
    () => releaseHighlights(status?.releaseNotesHtml),
    [status?.releaseNotesHtml],
  );
  if (!feedback.showUpdate || !status?.latest) return null;
  return (
    <Popover.Root
      open={feedback.updateOpen}
      onOpenChange={feedback.setUpdateOpen}
    >
      <Popover.Trigger>
        <Button
          variant="soft"
          className="update-trigger"
          aria-label={`有更新：v${status.latest}`}
          data-tip={`新版本 v${status.latest} 可用`}
        >
          <Download size={16} aria-hidden="true" />
          <span>有更新</span>
        </Button>
      </Popover.Trigger>
      <Popover.Content
        className="update-popover"
        width="360px"
        align="end"
        sideOffset={10}
        collisionPadding={12}
        aria-label="版本更新"
        onKeyDown={keepKeys}
      >
        <Heading as="h2">发现新版本</Heading>
        <p
          className="update-versions"
          aria-label={`当前 v${status.current}，最新 v${status.latest}`}
        >
          <span>v{status.current}</span>
          <ArrowRight size={14} aria-hidden="true" />
          <strong>v{status.latest}</strong>
        </p>
        {highlights.length ? (
          <ul className="update-highlights" aria-label="更新摘要">
            {highlights.map((text, index) => (
              <li key={index}>
                <span>{text}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="update-empty">更新内容请查看发布说明。</p>
        )}
        <p className="update-install-note">
          前往 GitHub 查看完整说明，下载后手动安装。
        </p>
        <div className="update-actions">
          <Button variant="solid" onClick={() => void feedback.openRelease()}>
            查看更新与下载
            <ExternalLink size={14} aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            color="gray"
            onClick={() => void feedback.dismiss()}
          >
            忽略此版本
          </Button>
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}
