'use strict';
// Real Pi -> production tool host -> native Logisim. Only the model's HTTP
// stream is a local fixture; no credentials, remote requests or user circuits.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {LensBackend}=require('../electron/backend.cjs');
const {DesktopWorkspace}=require('../electron/desktop-workspace.cjs');
const {DirectAgentWorkspace}=require('../electron/direct-agent-workspace.cjs');
const {AgentWorkspaceHost}=require('../electron/agent-workspace-host.cjs');
const {AgentToolHost}=require('../electron/agent-tool-host.cjs');
const {CircuitPlugin}=require('../electron/circuit-plugin.cjs');
const {BuiltinBackend}=require('../electron/builtin-backend.cjs');
async function run(api){
 const repo=path.resolve(__dirname,'../../..'),root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-builtin-native-')),folder=path.join(root,'folder');fs.mkdirSync(folder);
 const file=path.join(folder,'example.circ');const xml='<project source="2.16.2.2" version="1.0"><lib desc="#Wiring" name="0"/><main name="main"/><circuit name="main"><comp lib="0" name="Pin" loc="(80,100)"><a name="label" val="a"/></comp><comp lib="0" name="Pin" loc="(160,100)"><a name="label" val="b"/><a name="output" val="true"/><a name="facing" val="west"/></comp><wire from="(80,100)" to="(160,100)"/></circuit></project>';fs.writeFileSync(file,xml);
 const lens=new LensBackend({repoRoot:repo,stateDir:path.join(root,'lens')}),desktop=new DesktopWorkspace({stateRoot:path.join(root,'host'),backend:lens});let agent,requests=0;const outputs=[],payloads=[];
 const calls=[
  {name:'inspect_circuit',args:{}},
  {name:'inspect_circuit',args:{circuit:'main',componentDirectory:{}}},
  {name:'inspect_circuit',args:{circuit:'main',componentIds:['c80_100']}},
  {name:'inspect_circuit',args:{circuit:'main',portConnections:{ports:[{componentId:'c80_100',port:0}]}}},
  {name:'simulate_circuit',args:{circuit:'main',vectors:[{inputs:{a:0},expected:{b:0}},{inputs:{a:1},expected:{b:1}}]}},
  {name:'render_circuit',args:{circuit:'main'}},
 ];
 const server=http.createServer(async(req,res)=>{
   let raw='';for await(const chunk of req)raw+=chunk;payloads.push(JSON.parse(raw));requests++;
   res.writeHead(200,{'content-type':'text/event-stream'});
   const call=calls[requests-1];
   if(api==='openai-responses'){
    const send=event=>res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    const item=call?{type:'function_call',id:'fc_'+requests,call_id:'native-'+requests,name:call.name,arguments:JSON.stringify(call.args),status:'completed'}:
      {type:'message',id:'msg_'+requests,role:'assistant',status:'completed',content:[{type:'output_text',text:'检查完成'}]};
    send({type:'response.created',response:{id:'response_'+requests,status:'in_progress',output:[]}});
    send({type:'response.output_item.added',output_index:0,item:call?{...item,arguments:''}:{...item,content:[]}});
    if(call){
     send({type:'response.function_call_arguments.delta',item_id:item.id,output_index:0,delta:item.arguments});
     send({type:'response.function_call_arguments.done',item_id:item.id,output_index:0,arguments:item.arguments});
    }else{
     send({type:'response.content_part.added',item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:''}});
     send({type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:'检查完成'});
    }
    send({type:'response.output_item.done',output_index:0,item});
    send({type:'response.completed',response:{id:'response_'+requests,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});
    return res.end();
   }
   const send=(delta,finish_reason=null)=>res.write('data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})+'\n\n');
   if(call){send({role:'assistant',tool_calls:[{index:0,id:'native-'+requests,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}]});send({},'tool_calls');}
   else{send({role:'assistant',content:'检查完成'});send({},'stop');}res.end('data: [DONE]\n\n');});
 try{
  await lens.start();await desktop.open(folder,{activeFile:file});const session=await lens.session();
  const adapter=new DirectAgentWorkspace(desktop),plugin=new CircuitPlugin({workspace:adapter,invoke:p=>lens.circuitTool(p)});
  const toolHost=new AgentToolHost({plugin,manifest:()=>lens.circuitPlugin()});const originalCall=toolHost.call.bind(toolHost);toolHost.call=async(...args)=>{const value=await originalCall(...args);outputs.push(value);return value;};
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  agent=new BuiltinBackend({workDir:folder,profileDir:path.join(root,'profile'),sessionStorePath:path.join(root,'sessions.json'),workspaceHost:new AgentWorkspaceHost({adapter,mode:'direct'}),toolHost});
  agent.provider.save({baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'local-test-only',model:'fixture',api,effort:'none',vision:true});await agent.start();
  await agent.ask({question:'检查输入与输出',workspaceKey:session.folder.conversationKey,context:{folder:session.folder,revisionId:session.revision.id,projectId:session.workspace.id}});await agent.run;
  assert.equal(agent.snapshot().transmission,null);assert.equal(requests,calls.length+1);assert.equal(outputs.length,calls.length);
  assert.equal(outputs[0].project.mainCircuit,'main');assert.equal(outputs[1].components.length,2);
  assert.deepEqual(outputs[2].components.map(c=>c.componentId),['c80_100']);assert.equal(outputs[3].schema,'vibe-logisim.port-connections/v1');
  assert.equal(outputs[4].passed,2);assert.equal(outputs[5].modelContentItems.length,1);
  if(api==='openai-responses')for(const payload of payloads)for(const tool of payload.tools)assert.equal(tool.strict,false,tool.name);
  assert.equal(fs.readFileSync(file,'utf8'),xml);assert.equal(desktop.turnActive,false);
  console.log(JSON.stringify({api,minimalInspectionViews:['project','directory','components','connections'],nativeResults:outputs.map(x=>({keys:Object.keys(x),status:x.status,passed:x.passed})),sourceUnchanged:true,turnFinished:true}));
 }finally{await agent?.stop();server.closeAllConnections();server.close();desktop.folder.close();await desktop.queue.catch(()=>{});await lens.stop();fs.rmSync(root,{recursive:true,force:true});}
}
(async()=>{for(const api of ['openai-completions','openai-responses'])await run(api);})().catch(e=>{console.error(e);process.exitCode=1;});
