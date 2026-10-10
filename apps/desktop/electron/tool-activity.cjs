'use strict';
const LIMIT=6000;
const clip=value=>String(value??'').slice(0,LIMIT);
function toolActivity(event,previous={}){
  const done=event.type==='tool_execution_end',start=event.type==='tool_execution_start';
  const args=start?event.args:previous.toolOutput?.input;
  const result=done?event.result:event.partialResult;
  const text=(result?.content||[]).map(c=>c.type==='text'?c.text:`[${c.mimeType||'image'}]`).join('\n');
  let data;try{data=JSON.parse(text);}catch{}
  const type=event.toolName==='exec_command'?'command':['read_file','write_file','list_files'].includes(event.toolName)?'file':'tool';
  const exitCode=type==='command'?(Number.isInteger(data?.exitCode)?data.exitCode:Number.isInteger(data?.exit_code)?data.exit_code:null):null;
  const failed=done&&(event.isError||result?.isError||type==='tool'&&data?.error||exitCode!==null&&exitCode!==0);
  const outputText=type==='command'&&typeof data?.output==='string'?data.output:text;
  const toolOutput={type,
    target:clip(args?.path||args?.command||args?.cmd||''),input:args?JSON.parse(clipInput(args)):null,
    text:start?'':clip(outputText),exitCode,truncated:outputText.length>LIMIT};
  const input=start?clip(JSON.stringify(event.args)):previous.input;
  return {status:done?(failed?'failed':'completed'):'running',input,
    detail:start?input:`${input?'参数：'+input+'\n':''}${done?'结果':'输出'}：${clip(text)}`,
    toolOutput};
}
function clipInput(args){const text=JSON.stringify(args);return text.length<=LIMIT?text:JSON.stringify({preview:text.slice(0,LIMIT),truncated:true});}
module.exports={toolActivity};
