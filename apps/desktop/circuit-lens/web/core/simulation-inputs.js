// These are affordances from the loaded component type, not simulated values.
// The native observation still decides whether an input is parent-driven.
export function inputControl(component) {
  if (component.factory === 'Pin' && String(component.attributes?.output ?? false) === 'false') return 'input';
  if (component.factory === 'Clock') return 'clock';
  if (component.factory === 'Button') return 'pulse';
  return null;
}
