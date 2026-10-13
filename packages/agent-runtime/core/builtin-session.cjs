'use strict';
// Conversation-owned settings contain no credentials. Credentials stay in the
// provider store and are resolved only after the endpoint/protocol matches.
const endpoint = value => String(value || '').replace(/\/+$/, '');
function selectionFor(config) {
  return config ? {serviceId:config.id,baseUrl:endpoint(config.baseUrl),api:config.api,model:config.model,effort:config.effort,
    vision:config.vision===true,contextWindow:config.contextWindow} : null;
}
function sameService(a,b) { return Boolean(a&&b&&endpoint(a.baseUrl)===endpoint(b.baseUrl)&&a.api===b.api); }
function configurationIssue(selection,config,hasHistory) {
  if(!selection&&hasHistory)return {code:'unbound-history',message:'这条旧会话尚未记录模型服务。选择服务后再继续。'};
  if(selection&&!sameService(selection,config))return {code:'service-missing',message:`原模型服务不可用：${selection.baseUrl}`};
  return null;
}
function recoverHistory(history) {
  return history.map(m=>m.type==='user'&&m.delivery==='queued'?{...m,delivery:'deferred'}:m.type==='turn'&&m.status==='running'?{...m,status:'interrupted',error:'应用在回答结束前退出，已有内容已保留。',elapsedMs:m.elapsedMs||0}:
    m.type==='activity'&&m.status==='running'?{...m,status:'warning',resultStatus:'unknown',detail:[m.detail,'应用在调用结束前退出，结果未知，请先检查工作区。'].filter(Boolean).join('\n')}:m);
}
module.exports={selectionFor,sameService,configurationIssue,recoverHistory};
