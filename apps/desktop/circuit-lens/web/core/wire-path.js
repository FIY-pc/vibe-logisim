// The preview and committed path share exactly the same orthogonal corners.
export function wirePath(points) {
  const result = [];
  for (const point of points) {
    const last = result.at(-1);
    if (last?.x === point.x && last?.y === point.y) continue;
    if (last && last.x !== point.x && last.y !== point.y) result.push({x:point.x,y:last.y});
    result.push({x:point.x,y:point.y});
  }
  return result;
}
