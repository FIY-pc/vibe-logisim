const attributes={label:'标签',facing:'方向',width:'数据位宽',labelfont:'标签字体',labelcolor:'标签颜色',labelloc:'标签位置',trigger:'触发方式',value:'值',addrWidth:'地址位宽',dataWidth:'数据位宽'};
export function changeTitle(entry) {
  const title=entry?.title||'工程改动';
  return entry?.kind==='edit'&&attributes[entry.attribute]?title.replace(` · ${entry.attribute} → `,` · ${attributes[entry.attribute]} → `):title;
}
