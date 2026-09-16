// A view request may finish after navigation or a newer request. Its result
// can update the UI only while both its context and ordering are current.
export function createRequestScope(project) {
  let generation = 0;
  return {
    begin() {
      const token = ++generation;
      const projectId = project.session?.workspace?.id;
      const revision = project.revision;
      return () => token === generation
        && projectId === project.session?.workspace?.id
        && revision === project.revision;
    },
  };
}
