'use strict';
const fs=require('node:fs'),path=require('node:path');
const {atomic}=require('./folder-workspace.cjs');

// App-local viewing preferences survive the engine's changing localhost port.
// They are independent of circuit files, revisions, and workspace layout.
function registerCanvasPreferences({ipcMain,userData,trusted}) {
  const file=path.join(userData,'canvas-preferences.json');
  ipcMain.handle('vibe-logisim:canvas-preferences-read',event=>{
    if(!trusted(event))throw new Error('Untrusted renderer.');
    try{return {gridVisible:JSON.parse(fs.readFileSync(file,'utf8')).gridVisible===true};}
    catch{return {gridVisible:false};}
  });
  ipcMain.handle('vibe-logisim:canvas-preferences-write',(event,value)=>{
    if(!trusted(event))throw new Error('Untrusted renderer.');
    if(typeof value?.gridVisible!=='boolean')throw new Error('网格显示设置无效');
    atomic(file,{gridVisible:value.gridVisible});
  });
}
module.exports={registerCanvasPreferences};
