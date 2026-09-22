'use strict';

const {splitContext, keptObservationContext, materialContext} = require('./conversation-context.cjs');

// Domain projection for the circuit workspace. The Base Harness only sees
// the prepared projection and never needs to understand circuit fields.
class CircuitContextProvider {
  prepare(context = {}) {
    const {binding, untrustedEvidence} = splitContext(context);
    const encodedBinding = JSON.stringify(binding);
    const encodedEvidence = JSON.stringify(untrustedEvidence);
    const momentContext = keptObservationContext(context);
    const materials = materialContext(context);
    return {
      frozenContext: {
        projectId:context.projectId || null,
        plugin: context.plugin ? {id:context.plugin.id, version:context.plugin.version} : null,
        folderId:context.folder?.id || null,
        moments:(context.keptMoments || []).map(m => ({id:m.id, projectId:m.projectId, title:m.title})),
        materials:(context.materials || []).map(m => ({id:m.id, name:m.name, pathVersion:m.pathVersion,
          page:m.page, quote:m.quote, reference:m.reference})),
        revisionId:context.revisionId || null,
        selectionId:context.selectionId || null,
        circuit:context.circuit || null,
        summary:context.summary || null,
        authority:context.authority || 'unknown',
        observationId:context.displayedSimulation?.id || null,
        simulationSessionId:context.displayedSimulation?.sessionId || null,
        simulationTick:context.displayedSimulation?.ticks ?? null,
        simulationInstancePath:context.displayedSimulation?.instancePath || [],
        simulationRootCircuit:context.displayedSimulation?.rootCircuit || null,
      },
      binding:encodedBinding,
      evidence:encodedEvidence,
      moments:momentContext,
      materials,
      folderId:context.folder?.id || null,
      activeFile:context.folder?.activeFile || null,
      sizeBytes:Buffer.byteLength(encodedBinding, 'utf8') + Buffer.byteLength(encodedEvidence, 'utf8'),
    };
  }

  additionalContext(prepared, {cwd, workspaceIndex = null} = {}) {
    const activeFile = typeof workspaceIndex?.activeFile === 'string'
      ? workspaceIndex.activeFile
      : prepared.activeFile;
    return {
      'vibe-logisim.binding': {value:prepared.binding, kind:'application'},
      'vibe-logisim.evidence': {value:prepared.evidence, kind:'untrusted'},
      ...prepared.moments,
      ...prepared.materials,
      'vibe-logisim.workspace': {value:JSON.stringify({
        cwd,
        file:activeFile,
        folderId:prepared.folderId,
        changeMode:'direct',
        currentSource:workspaceIndex?.currentSource || null,
      }), kind:'application'},
      ...(workspaceIndex ? {'vibe-logisim.workspace-index': {value:JSON.stringify(workspaceIndex), kind:'untrusted'}} : {}),
    };
  }
}

module.exports = {CircuitContextProvider};
