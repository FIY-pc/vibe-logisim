// These are references into the message's workspace, never host filesystem URLs.
// Keep the native mount in sync with electron/agent-process.cjs.
const nativeRoot='/tmp/workspace/';
const invalidPath=/[\\\u0000-\u001f\u007f]|%2e|%2f|%5c|%00/i;
function filePath(value) {
  if(!value||invalidPath.test(value)||value.startsWith('/')||/^[a-z][a-z\d+.-]*:/i.test(value))return null;
  if(value.split('/').some(part=>!part||part==='.'||part==='..'))return null;
  return value;
}
function integer(value,fallback,min) {
  if(value===null)return fallback;
  if(!/^\d+$/.test(value))throw new Error('文件引用无效');
  const number=Number(value);
  if(!Number.isSafeInteger(number)||number<min)throw new Error('文件引用无效');
  return number;
}

export function parseConversationReference(value) {
  if(typeof value!=='string'||/[\u0000-\u0020\u007f]/.test(value))return null;
  try {
    if(/^https?:\/\//i.test(value)){new URL(value);return {kind:'web',href:value};}
    if(/^circuit:\/\/object\?/i.test(value))return {kind:'circuit',href:value};
    if(/^(workspace|material):\/\/file\?/i.test(value)) {
      const url=new URL(value),legacy=url.protocol==='material:',params=url.searchParams;
      if(url.hash||[...params.keys()].some(key=>params.getAll(key).length!==1))return null;
      const owner=params.get(legacy?'projectId':'folderId'),path=filePath(params.get(legacy?'id':'path'));
      if(!owner||!path)return null;
      return {kind:'file',owner,legacy,path,page:integer(params.get('page'),1,1),pathVersion:integer(params.get('pathVersion'),0,0)};
    }
    // Decode exactly once, before testing traversal. Do not let URL normalize
    // dot segments or backslashes into an apparently safe mount-relative path.
    let path=decodeURIComponent(value);
    if(path.startsWith('file://'+nativeRoot))path=path.slice('file://'.length);
    if(path.startsWith(nativeRoot))path=path.slice(nativeRoot.length);
    else if(path.startsWith('./'))path=path.slice(2);
    if(/[?#]/.test(path))return null;
    path=filePath(path);
    return path?{kind:'file',path,native:true,page:1}:null;
  } catch {return null;}
}

export function resolveConversationFile(reference,binding,folder) {
  if(reference?.kind!=='file')throw new Error('文件引用无效');
  if(!binding?.folderId&&!(reference.legacy&&binding?.projectId&&folder?.documentIds?.includes(binding.projectId)))throw new Error('无法确认这条文件路径所属的工作区');
  if(!folder?.id||(binding?.folderId&&binding.folderId!==folder.id))throw new Error('文件属于另一工作区');
  if(!reference.native && reference.owner!==folder.id && !(reference.legacy&&folder.documentIds?.includes(reference.owner)))throw new Error('文件属于另一工作区');
  let pathVersion=reference.pathVersion;
  if(reference.native) {
    if(!binding?.folderId)throw new Error('无法确认这条文件路径所属的工作区');
    pathVersion=binding.pathVersion;
    if(pathVersion==null) {
      // Old native-path messages have no persisted move version. Refuse to
      // guess between a relocated file and a new file reusing its old name.
      const touches=path=>reference.path===path||reference.path.startsWith(path+'/');
      if((folder.moves||[]).some(move=>touches(move.from)||touches(move.to)))throw new Error('这条历史文件路径经历过移动，无法确认原文件；请从文件树打开');
      pathVersion=(folder.moves||[]).length;
    }
  }
  if(!Number.isSafeInteger(pathVersion)||pathVersion<0||pathVersion>(folder.moves||[]).length)throw new Error('文件引用版本无效');
  return {folderId:folder.id,path:reference.path,page:reference.page,pathVersion};
}
