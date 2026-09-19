import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseConversationReference as parse,resolveConversationFile as resolve} from '../circuit-lens/web/core/conversation-reference.js';

const folder={id:'folder-a',documentIds:['project-a'],moves:[]},binding={folderId:'folder-a',pathVersion:0};
test('native and relative paths become workspace references, including encoded Unicode',()=>{
  for(const value of ['/tmp/workspace/design.circ','./design.circ','design.circ','file:///tmp/workspace/design.circ'])
    assert.deepEqual(resolve(parse(value),binding,folder),{folderId:'folder-a',path:'design.circ',page:1,pathVersion:0});
  assert.equal(parse('/tmp/workspace/%E8%AF%B4%E6%98%8E%20%E6%96%87%E4%BB%B6.md').path,'说明 文件.md');
});
test('reject traversal, external absolute paths, malformed URLs and unsafe schemes before file access',()=>{
  for(const value of ['/etc/passwd','/tmp/workspace-other/design.circ','//host/file','C:/secret','file:///etc/passwd','file://host/file',
    '/tmp/workspace/../secret','/tmp/workspace/%2e%2e/secret','/tmp/workspace/%252e%252e/secret','/tmp/workspace/a/../../b',
    '/tmp/workspace/a\\b','/tmp/workspace/%00secret','/tmp/workspace/%','javascript:alert(1)','data:text/plain,secret',
    'workspace://file?folderId=folder-a&path=..%2Fsecret','workspace://file?folderId=folder-a&path=%2Fetc%2Fpasswd',
    'workspace://file?folderId=folder-a&path=a&path=b','workspace://file?folderId=folder-a&path=a&pathVersion=-1',
    'workspace://file?folderId=folder-a&path=a&pathVersion=1.2','workspace://file?folderId=folder-a&path=a&page=0',
    'workspace://file?folderId=folder-a&path=a&pathVersion=9007199254740992'])assert.equal(parse(value),null,value);
});
test('message ownership is required and cannot be retargeted to another folder',()=>{
  const ref=parse('/tmp/workspace/design.circ');
  assert.throws(()=>resolve(ref,null,folder),/无法确认/);
  assert.throws(()=>resolve(ref,binding,{...folder,id:'folder-b'}),/另一工作区/);
  assert.throws(()=>resolve(parse('workspace://file?folderId=folder-b&path=design.circ'),binding,folder),/另一工作区/);
  assert.throws(()=>resolve(parse('workspace://file?folderId=folder-a&path=design.circ'),null,folder),/无法确认/);
});
test('explicit versions pass unchanged to the existing move resolver; ambiguous old raw paths fail closed',()=>{
  const moved={...folder,moves:[{from:'design.circ',to:'archive/design.circ'}]};
  assert.equal(resolve(parse('workspace://file?folderId=folder-a&path=design.circ&pathVersion=0'),binding,moved).pathVersion,0);
  assert.equal(resolve(parse('/tmp/workspace/design.circ'),binding,moved).pathVersion,0);
  assert.throws(()=>resolve(parse('/tmp/workspace/design.circ'),{folderId:folder.id},moved),/历史文件路径/);
  assert.equal(resolve(parse('notes.md'),{folderId:folder.id},moved).pathVersion,1);
  assert.equal(resolve(parse('design.circ'),{...binding,pathVersion:1},moved).pathVersion,1);
  assert.throws(()=>resolve(parse('workspace://file?folderId=folder-a&path=design.circ&pathVersion=2'),binding,moved),/版本/);
});
test('legacy material, circuit and web references remain supported',()=>{
  assert.deepEqual(resolve(parse('material://file?projectId=project-a&id=notes.md&page=2'),binding,folder),{folderId:'folder-a',path:'notes.md',page:2,pathVersion:0});
  assert.equal(resolve(parse('material://file?projectId=project-a&id=notes.md'),{projectId:'project-a'},folder).path,'notes.md');
  assert.equal(parse('circuit://object?projectId=project-a&componentId=pin').kind,'circuit');
  assert.equal(parse('https://example.org/path').kind,'web');
});
