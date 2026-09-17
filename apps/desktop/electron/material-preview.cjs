"use strict";
const path=require('node:path');
const {renderPdf}=require('./pdf-preview.cjs');
const TEXT=new Set(['.txt','.md','.csv','.tsv','.json','.xml','.circ','.v','.sv','.vh','.asm','.s','.hex','.log','.py','.c','.h','.yaml','.yml']);

// A bounded read-only preview. Never execute an attachment or render its HTML.
async function previewMaterial(store,projectId,id,page=1,nativeImage) {
  if(!Number.isInteger(page)||page<1||page>10000)throw new Error('页码无效');
  const {item,bytes}=store.read(projectId,id),ext=path.extname(item.name).toLowerCase();
  const result={item,kind:'unsupported',page:1,pages:1,text:'',note:'该格式尚无内置预览，AI 可以按需读取工程中的文件。'};
  if(TEXT.has(ext)) {
    const text=bytes.toString('utf8');
    if(text.includes('\u0000'))return {...result,note:'文件包含二进制内容，无法按文本预览。'};
    const pages=Math.max(1,Math.ceil(text.length/30000));
    if(page>pages)throw new Error('引用的文本段不存在');
    const actual=page;
    return {...result,kind:'text',page:actual,pages,text:text.slice((actual-1)*30000,actual*30000),note:pages>1?'长文件分段预览':'文本预览'};
  }
  if(['.png','.jpg','.jpeg','.gif','.webp','.bmp'].includes(ext)) {
    const original=nativeImage.createFromBuffer(bytes);
    if(original.isEmpty())throw new Error('图片无法解码，原文件仍保留');
    const size=original.getSize(),factor=Math.min(1,1600/Math.max(size.width,size.height));
    const image=factor<1?original.resize({width:Math.max(1,Math.round(size.width*factor))}):original;
    return {...result,kind:'image',data:image.toDataURL(),note:`${size.width} × ${size.height}${ext==='.gif'?' · 静态预览':''}`};
  }
  if(ext!=='.pdf')return result;
  const rendered=await renderPdf(bytes,page);
  return {...result,...rendered,kind:'pdf',note:rendered.text?'PDF 原页与可选文字':'PDF 原页 · 此页没有可提取文字'};
}
module.exports={previewMaterial};
