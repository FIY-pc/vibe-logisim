/** Receipt of a host-owned circuit tool: which document, file and canvas the call left. */
export interface AgentSession {
  folderId: string | null;
  documentId: string | null;
  revision: string | null;
  artifactSha256: string | null;
  activeFile: string | null;
  project: { circuits: string[]; mainCircuit: string | null };
  activeCircuit: string | null;
  canvas?: { status: string; circuit: string | null } | null;
  saveState: {
    currentRevisionId: string | null;
    savedRevisionId: string | null;
    dirty: boolean;
    canSave: boolean;
  } | null;
  sourceStatus: unknown;
  previousRevision: string | null;
  baselines: Record<string, string>;
  nativeLoadability?: unknown;
}

// Current, saved and disk identities describe independent states. Equal
// hashes do not allow inferring one from another, or imply functional proof.
export function circuitActionResult(
  session: AgentSession,
  { candidateId }: { candidateId?: string } = {},
) {
  const canvas = session.canvas ?? { status: "unavailable", circuit: null };
  return {
    schema: "vibe-logisim.circuit-action/v1",
    ...(candidateId ? { candidateId } : {}),
    binding: {
      folderId: session.folderId ?? null,
      projectId: session.documentId ?? null,
      revisionId: session.revision ?? null,
      artifactSha256: session.artifactSha256 ?? null,
    },
    file: session.activeFile ?? null,
    activeCircuit: canvas.status === "shown" ? canvas.circuit : null,
    canvas: structuredClone(canvas),
    circuits: [...(session.project?.circuits ?? [])],
    saveState: session.saveState ? { ...session.saveState } : null,
    sourceStatus: structuredClone(session.sourceStatus ?? null),
    nativeLoadability: structuredClone(session.nativeLoadability ?? null),
    connectionIndex: null,
  };
}
