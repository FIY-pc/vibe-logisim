export const categories = {interfaces:'接口与封装', components:'元件', connections:'信号连接', layout:'布局与布线'};
export const fields = {位置:'位置',label:'名称',width:'位宽',output:'输出引脚',facing:'方向',labelloc:'标签位置',
  labelfont:'标签字体',labelcolor:'标签颜色',trigger:'触发方式',value:'值',contents:'存储内容',text:'文字',
  tristate:'三态',pull:'上拉 / 下拉',font:'字体',color:'颜色',appearance:'封装样式'};
const factories = {Pin:'引脚',Register:'寄存器',Tunnel:'隧道',Text:'文字',Clock:'时钟',Multiplexer:'选择器'};
const portNames = {'Add an input pin':'电路输入','Add an output pin':'电路输出',
  "Output: register's current value":'输出 Q','Data: value stored on clock trigger':'数据 D'};
export const factoryName = c => factories[c.factory] || c.factory;
export function endpointText(e) {
  const bits=e.bits || [];
  const range=bits.length>1 && bits.every((b,i)=>!i||b===bits[i-1]+1) ? `${bits.at(-1)}:${bits[0]}` : bits.join(',');
  return `${e.label}（${factoryName(e)}）· ${portNames[e.portName]||e.portName}${e.width>1?` [${range}]`:''}`;
}
export function rowTitle(row) {
  if(row.kind!=='connection')return row.title;
  const endpoint=(row.after.connections.flat().find(e=>e.label!==e.factory)||row.before.connections.flat()[0]);
  return `${endpoint?.label || '端口'} · ${row.bitCount>1?row.bitCount+' 位':''}连接${{added:'新增',removed:'移除',modified:'改变'}[row.change]}`;
}
export function rowObjects(row,side) { return row?.[side] || {components:[],wires:[]}; }
export function objectBounds(objects) {
  const boxes=(objects.components||[]).map(c=>c.bounds).filter(Boolean);
  for(const w of objects.wires||[])boxes.push({x:Math.min(w.from.x,w.to.x),y:Math.min(w.from.y,w.to.y),width:Math.abs(w.from.x-w.to.x),height:Math.abs(w.from.y-w.to.y)});
  if(!boxes.length)return null;
  const x=Math.min(...boxes.map(b=>b.x)), y=Math.min(...boxes.map(b=>b.y));
  return {x,y,width:Math.max(...boxes.map(b=>b.x+b.width))-x,height:Math.max(...boxes.map(b=>b.y+b.height))-y};
}
