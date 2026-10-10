'use strict';
const fs=require('node:fs'),path=require('node:path');
const {atomic}=require('./folder-workspace.cjs');

function validate(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>64)throw new Error('快捷键配置格式无效');
  const entries=Object.entries(value);
  if(entries.some(([key,binding])=>!/^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(key)||(binding!==null&&(typeof binding!=='string'||binding.length>48))))throw new Error('快捷键配置格式无效');
  return Object.fromEntries(entries);
}

function registerShortcutPreferences({ipcMain,userData,trusted}) {
  const file=path.join(userData,'shortcut-preferences.json');
  ipcMain.handle('vibe-logisim:shortcuts-read',event=>{
    if(!trusted(event))throw new Error('Untrusted renderer.');
    try{return validate(JSON.parse(fs.readFileSync(file,'utf8')));}
    catch(error){if(error.code==='ENOENT')return {};throw error;}
  });
  ipcMain.handle('vibe-logisim:shortcuts-write',(event,value)=>{
    if(!trusted(event))throw new Error('Untrusted renderer.');
    atomic(file,validate(value));
  });
}
module.exports={registerShortcutPreferences};
