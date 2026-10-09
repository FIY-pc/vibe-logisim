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
(async()=>{
 const repo=path.resolve(__dirname,'../../..'),root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-builtin-native-')),folder=path.join(root,'folder');fs.mkdirSync(folder);
 const file=path.join(folder,'example.circ');const xml='<project source="2.16.2.2" version="1.0"><lib desc="#Wiring" name="0"/><main name="main"/><circuit name="main"><comp lib="0" name="Pin" loc="(80,100)"><a name="label" val="a"/></comp><comp lib="0" name="Pin" loc="(160,100)"><a name="label" val="b"/><a name="output" val="true"/><a name="facing" val="west"/></comp><wire from="(80,100)" to="(160,100)"/></circuit></project>';fs.writeFileSync(file,xml);
 const lens=new LensBackend({repoRoot:repo,stateDir:path.join(root,'lens')}),desktop=new DesktopWorkspace({stateRoot:path.join(root,'host'),backend:lens});let agent,requests=0;const outputs=[];
 const server=http.createServer(async(req,res)=>{for await(const chunk of req){}requests++;res.writeHead(200,{'content-type':'text/event-stream'});
   const send=(delta,finish_reason=null)=>res.write('data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})+'\n\n');
   if(requests<4){const name=requests===1?'inspect_circuit':requests===2?'simulate_circuit':'render_circuit',args=requests===1?{circuit:'main',includeWires:true}:requests===3?{circuit:'main'}:{circuit:'main',vectors:[{inputs:{a:0},expected:{b:0}},{inputs:{a:1},expected:{b:1}}]};send({role:'assistant',tool_calls:[{index:0,id:'native-'+requests,type:'function',function:{name,arguments:JSON.stringify(args)}}]});send({},'tool_calls');}
   else{send({role:'assistant',content:'检查完成'});send({},'stop');}res.end('data: [DONE]\n\n');});
 try{
  await lens.start();await desktop.open(folder,{activeFile:file});const session=await lens.session();
  const adapter=new DirectAgentWorkspace(desktop),plugin=new CircuitPlugin({workspace:adapter,invoke:p=>lens.circuitTool(p)});
  const toolHost=new AgentToolHost({plugin,manifest:()=>lens.circuitPlugin()});const originalCall=toolHost.call.bind(toolHost);toolHost.call=async(...args)=>{const value=await originalCall(...args);outputs.push(value);return value;};
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  agent=new BuiltinBackend({workDir:folder,profileDir:path.join(root,'profile'),sessionStorePath:path.join(root,'sessions.json'),workspaceHost:new AgentWorkspaceHost({adapter,mode:'direct'}),toolHost});
  agent.provider.save({baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'local-test-only',model:'fixture',api:'openai-completions',effort:'none',vision:true});await agent.start();
  await agent.ask({question:'检查输入与输出',workspaceKey:session.folder.conversationKey,context:{folder:session.folder,revisionId:session.revision.id,projectId:session.workspace.id}});await agent.run;
  assert.equal(agent.snapshot().transmission,null);assert.equal(requests,4);assert.equal(outputs.length,3);assert.equal(outputs[1].passed,2);assert.equal(outputs[2].modelContentItems.length,1);assert.ok(outputs[0].artifactSha256);assert.equal(fs.readFileSync(file,'utf8'),xml);assert.equal(desktop.turnActive,false);
  console.log(JSON.stringify({nativeResults:outputs.map(x=>({keys:Object.keys(x),status:x.status,passed:x.passed,simulation:x.simulation})),sourceUnchanged:true,turnFinished:true}));
 }finally{await agent?.stop();server.closeAllConnections();server.close();desktop.folder.close();await desktop.queue.catch(()=>{});await lens.stop();fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
