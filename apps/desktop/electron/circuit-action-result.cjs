'use strict';

// Host actions acknowledge the selected document. The desktop retains its full
// session; circuit observation and native execution have their own tools.
function circuitActionResult(session, {candidateId} = {}) {
  if (session?.schema !== 'vibe-logisim.circuit-lens/v0') {
    throw new Error('电路操作未返回有效的工作区状态');
  }
  const workspace = session.workspace;
  return {
    schema: 'vibe-logisim.circuit-action/v1',
    ...(candidateId ? {candidateId} : {}),
    binding: {
      folderId: session.folder?.id ?? null,
      projectId: workspace?.id ?? null,
      revisionId: session.revision?.id ?? null,
      artifactSha256: session.revision?.artifactSha256 ?? null,
    },
    file: session.folder?.activeFile ?? null,
    activeCircuit: session.activeCircuit ?? null,
    circuits: session.project?.circuits?.map(circuit => circuit.name) ?? [],
    // Current, saved and disk identities describe independent states. Equal
    // hashes do not allow inferring one from another, or imply functional proof.
    saveState: workspace ? {
      currentRevisionId: workspace.currentRevisionId,
      savedRevisionId: workspace.savedRevisionId,
      dirty: workspace.dirty,
      canSave: workspace.canSave,
    } : null,
    sourceStatus: structuredClone(session.sourceStatus),
    connectionIndex: structuredClone(session.connectionIndex ?? null),
  };
}

module.exports = {circuitActionResult};
