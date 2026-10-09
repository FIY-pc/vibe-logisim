'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const desktop=path.resolve(__dirname,'../../apps/desktop');
const {build,Platform,Arch}=require(path.join(desktop,'node_modules/electron-builder'));
async function installer(root,archive){
  if(process.platform!=='win32')throw new Error('Build the Windows installer on Windows.');
  const out=await fs.mkdtemp(path.join(path.dirname(archive),'nsis-'));
  try {
    const files=await build({projectDir:desktop,prepackaged:root,targets:Platform.WINDOWS.createTarget('nsis',Arch.x64),publish:'never',config:{
      appId:'org.vibelogisim.desktop',productName:'Vibe Logisim',executableName:'vibe-logisim',electronVersion:require(path.join(desktop,'package.json')).devDependencies.electron,
      directories:{output:out},compression:'maximum',artifactName:'Vibe-Logisim-Setup.${ext}',
      win:{signAndEditExecutable:false},nsis:{oneClick:false,perMachine:false,allowElevation:false,allowToChangeInstallationDirectory:true,deleteAppDataOnUninstall:false,createDesktopShortcut:true,shortcutName:'Vibe Logisim',runAfterFinish:false},
    }});
    const exe=files.find(f=>f.endsWith('.exe'));if(!exe)throw new Error('NSIS did not produce an installer');
    await fs.rename(exe,archive);
  }finally{await fs.rm(out,{recursive:true,force:true});}
}
if(require.main===module)installer(path.resolve(process.argv[2]),path.resolve(process.argv[3])).catch(error=>{console.error(error);process.exitCode=1;});
module.exports={installer};
