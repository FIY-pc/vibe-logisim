import { ProjectInfo } from "../../components/ProjectInfo";
import { useDocuments, useFiles } from "../../workbench/hooks";

/** File information and export for an open document. */
export function ProjectInfoRegion() {
  const docs = useDocuments((state) => state.docs);
  const infoTarget = useFiles((state) => state.infoTarget);
  const setInfoTarget = useFiles((state) => state.setInfoTarget);
  if (!infoTarget || !docs.some((document) => document.id === infoTarget))
    return null;
  return (
    <ProjectInfo
      key={infoTarget}
      doc={docs.find((document) => document.id === infoTarget)!}
      onClose={() => setInfoTarget(null)}
    />
  );
}
