"use strict";
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const run=promisify(execFile);
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
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-material-preview-'));
  try {
    const file=path.join(temporary,'document.pdf');fs.writeFileSync(file,bytes,{mode:0o600});
    const options={timeout:15000,maxBuffer:2*1024*1024,env:{...process.env,LC_ALL:'C'}};
    const info=await run('pdfinfo',[file],options),pages=Number(info.stdout.match(/^Pages:\s+(\d+)/m)?.[1]);
    if(!pages)throw new Error('无法读取 PDF 页数');
    if(page>pages){const error=new Error(`这份 PDF 只有 ${pages} 页，引用的第 ${page} 页不存在`);error.code='PAGE_NOT_FOUND';throw error;}
    const actual=page;
    const output=await run('pdftotext',['-f',String(actual),'-l',String(actual),'-layout',file,'-'],options);
    const text=output.stdout.trim().slice(0,30000);
    await run('pdftoppm',['-f',String(actual),'-l',String(actual),'-singlefile','-scale-to','1400','-png',file,path.join(temporary,'page')],options);
    return {...result,kind:'pdf',page:actual,pages,text,data:'data:image/png;base64,'+fs.readFileSync(path.join(temporary,'page.png')).toString('base64'),note:text?'PDF 原页与可选文字':'PDF 原页 · 此页没有可提取文字'};
  }catch(error) {
    if(error.code==='PAGE_NOT_FOUND')throw error;
    if(error.code==='ENOENT')throw new Error('PDF 预览需要本机 Poppler（pdfinfo、pdftotext、pdftoppm），文件已保存且仍可被 AI 读取');
    throw new Error('PDF 预览失败，文件已保留；可重试或选择其他资料');
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
}
module.exports={previewMaterial};
