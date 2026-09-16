export function wireOverlaps(a,b){
  const horizontal=a.from.y===a.to.y,axis=horizontal?'x':'y',other=horizontal?'y':'x';
  return a.from[other]===b.from[other]&&a.from[other]===b.to[other]&&
    Math.max(Math.min(a.from[axis],a.to[axis]),Math.min(b.from[axis],b.to[axis]))<Math.min(Math.max(a.from[axis],a.to[axis]),Math.max(b.from[axis],b.to[axis]));
}
export function within(p,r){return p.x>=r.x&&p.x<=r.x+r.width&&p.y>=r.y&&p.y<=r.y+r.height;}
export function wireInRectangle(w,r,crossing=false){
  if(!crossing)return within(w.from,r)&&within(w.to,r);
  return Math.max(w.from.x,w.to.x)>=r.x&&Math.min(w.from.x,w.to.x)<=r.x+r.width&&
    Math.max(w.from.y,w.to.y)>=r.y&&Math.min(w.from.y,w.to.y)<=r.y+r.height;
}
