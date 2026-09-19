'use strict';

// Code Mode's number/Array declarations omit JSON Schema bounds (and integer).
// Keep the executable schema untouched. Put only those missing facts in the
// tool description, which survives native rendering even for nested items/maps.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function range(schema, minimum, maximum) {
  const low = schema[minimum], high = schema[maximum];
  if (low !== undefined && high !== undefined) return `${low}..${high}`;
  if (low !== undefined) return `>=${low}`;
  if (high !== undefined) return `<=${high}`;
  return '';
}

function schemaConstraints(schema) {
  const groups = new Map();
  const visit = (node, path) => {
    if (!object(node)) return;
    const rules = [];
    const numeric = range(node, 'minimum', 'maximum');
    if (node.type === 'integer') rules.push(['integer', numeric].filter(Boolean).join(' '));
    else if (numeric) rules.push(numeric);
    if (node.multipleOf !== undefined) rules.push(`multiple of ${node.multipleOf}`);
    for (const [low, high, unit] of [
      ['minItems', 'maxItems', 'items'],
      ['minLength', 'maxLength', 'characters'],
      ['minProperties', 'maxProperties', 'properties'],
    ]) {
      const bound = range(node, low, high);
      if (bound) rules.push(`${bound} ${unit}`);
    }
    if (rules.length) {
      const rule = rules.join(', ');
      if (!groups.has(rule)) groups.set(rule, []);
      groups.get(rule).push(path || 'arguments');
    }
    for (const name of Object.keys(node.properties || {}).sort()) {
      // Brackets keep unusual property names unambiguous; catalog names use dots.
      const field = /^[A-Za-z_$][\w$]*$/.test(name) ? (path ? '.' : '') + name : `[${JSON.stringify(name)}]`;
      visit(node.properties[name], path + field);
    }
    visit(node.items, path + '[]');
    visit(node.additionalProperties, path + '.*');
  };
  visit(schema, '');
  return [...groups].map(([rule, paths]) => `${paths.join(', ')}: ${rule}`).join('; ');
}

function projectToolInterface({type, name, description, inputSchema}) {
  const bounds = schemaConstraints(inputSchema);
  return {type, name, description:description + (bounds ? `\n\nParameter bounds (inclusive, when supplied): ${bounds}.` : ''), inputSchema};
}

module.exports = {projectToolInterface, schemaConstraints};
