import {
  FeedbackDialog,
  type FeedbackController,
} from "../../components/Feedback";

/** The feedback dialog, while the feedback menu has it open. */
export function FeedbackDialogRegion({
  feedback,
}: {
  feedback: FeedbackController;
}) {
  if (!feedback.dialogOpen) return null;
  return <FeedbackDialog onClose={() => feedback.setDialogOpen(false)} />;
}
