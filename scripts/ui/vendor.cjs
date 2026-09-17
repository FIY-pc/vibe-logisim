'use strict';
// Deterministic local assets: no CDN requests while reading a conversation.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../apps/desktop'),target=path.join(root,'circuit-lens/web/vendor');
fs.mkdirSync(target,{recursive:true});
for(const [source,name] of [['marked/lib/marked.esm.js','marked.js'],['dompurify/dist/purify.es.mjs','purify.js'],['marked/LICENSE','marked.LICENSE'],['dompurify/LICENSE','purify.LICENSE'],['lucide/LICENSE','lucide.LICENSE']])fs.copyFileSync(path.join(root,'node_modules',source),path.join(target,name));
const lucide=require(path.join(root,'node_modules/lucide'));
const names=['SquarePen','Pencil','Archive','ArchiveRestore','BookOpen','ScanSearch','Timer','ArrowUpRight','FilePlus2','FolderPlus','FileCode2','FileImage','FileArchive','FileSpreadsheet','FileType','Link','LocateFixed','Ellipsis','ChevronsDownUp','ExternalLink','Eye','EyeOff','Folder','FolderOpen','History','CircuitBoard','Settings','Copy','Split','ArrowUp','Square','Paperclip','ChevronDown','ChevronRight','Check','Search','X','MessageSquare','Maximize2','Minimize2','Cpu','SlidersHorizontal','RefreshCw','Files','FileText','Image','File','Plus','Trash2','Undo2','ChevronLeft','ChevronUp','PanelLeftOpen','PanelLeftClose','PanelRightOpen','PanelRightClose'];
fs.writeFileSync(path.join(target,'icons.js'),'// Generated from the pinned Lucide package. See lucide.LICENSE.\nexport default '+JSON.stringify(Object.fromEntries(names.map(name=>[name,lucide[name]])))+';\n');
