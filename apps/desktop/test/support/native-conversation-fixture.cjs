'use strict';
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');

// Synthetic history only, written to an isolated acceptance profile. Native
// app-server reads/resumes/forks it; no authentication or user history is copied.
function seedNativeConversation(profile, cwd, historyMode='paginated') {
  const threadId=randomUUID(),timestamp=new Date().toISOString(),records=[],turnIds=[];
  const put=(type,payload)=>records.push({timestamp,ordinal:records.length,type,payload});
  put('session_meta',{id:threadId,session_id:threadId,timestamp,cwd,originator:'vibe-fork-acceptance',cli_version:'0.153.3',source:'vscode',
    model_provider:'openai',history_mode:historyMode,base_instructions:{text:'Explicit acceptance fixture. No model generation was performed.'}});
  const questions=['讲解全加器进位','再讨论计数器','最后讨论流水线'];
  for(let n=1;n<=3;n++) {
    const turnId=randomUUID();turnIds.push(turnId);
    const question=questions[n-1],answer='验收历史 '+n+'：'+question+'。';
    put('event_msg',{type:'task_started',turn_id:turnId,model_context_window:100000,collaboration_mode_kind:'default'});
    put('event_msg',{type:'user_message',message:question,images:[],local_images:[],text_elements:[]});
    put('response_item',{type:'message',role:'user',id:'user-'+n,content:[{type:'input_text',text:question}]});
    put('response_item',{type:'function_call',id:'call-'+n,call_id:'call-'+n,name:'inspect_circuit',arguments:'{"fixture":true}'});
    put('response_item',{type:'function_call_output',call_id:'call-'+n,output:'LOCAL_TOOL_EVIDENCE_'+n});
    put('response_item',{type:'message',role:'assistant',id:'assistant-'+n,phase:'final_answer',content:[{type:'output_text',text:answer}]});
    put('event_msg',{type:'agent_message',message:answer,phase:'final_answer'});
    if(historyMode==='paginated') {
      put('event_msg',{type:'item_completed',thread_id:threadId,turn_id:turnId,item:{type:'UserMessage',id:'user-'+n,client_id:'user-'+n,
        content:[{type:'text',text:question,text_elements:[]}]},started_at_ms:1,completed_at_ms:2});
      put('event_msg',{type:'item_completed',thread_id:threadId,turn_id:turnId,item:{type:'AgentMessage',id:'assistant-'+n,
        phase:'final_answer',content:[{type:'Text',text:answer}]},started_at_ms:2,completed_at_ms:3});
    }
    put('event_msg',{type:'task_complete',turn_id:turnId,last_agent_message:answer});
  }
  const dir=path.join(profile,'sessions',...timestamp.slice(0,10).split('-'));fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'rollout-'+timestamp.slice(0,19).replaceAll(':','-')+'-'+threadId+'.jsonl');
  fs.writeFileSync(file,records.map(r=>JSON.stringify(r)).join('\n')+'\n');
  return {threadId,turnIds,file};
}

module.exports={seedNativeConversation};
