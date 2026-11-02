import fs from 'node:fs/promises';import path from 'node:path';import {Presentation,PresentationFile} from '@oai/artifact-tool';
const root='D:/project/vibe-logisim',workspace=process.env.REPORT_WORKSPACE||root+'/.workbench-cache/report-dynamic',b=workspace+'/build',o=workspace+'/output',a=process.env.REPORT_ASSETS||b+'/assets';
const stats=JSON.parse(await fs.readFile(o+'/代码量统计.json','utf8')),perf=JSON.parse(await fs.readFile(o+'/接口响应实测.json','utf8'));
const p=Presentation.create({slideSize:{width:1280,height:720}}),font='Microsoft YaHei',ink='#121D35',muted='#66748B',blue='#3568FF',navy='#081225',pale='#F3F6FC';
let n=0;const notes=[],tables=[],movies=[];
function txt(s,v,x,y,w,h,size=28,color=ink,bold=false){const t=s.shapes.add({geometry:'textbox',position:{left:x,top:y,width:w,height:h},fill:'none',line:{fill:'none',width:0}});t.text=v;t.text.style={typeface:font,fontSize:size,color,bold};return t}
function box(s,x,y,w,h,color){return s.shapes.add({geometry:'rect',position:{left:x,top:y,width:w,height:h},fill:color,line:{fill:'none',width:0}})}
function page(title,seconds,script,source='',dark=false){const s=p.slides.add();n++;s.background.fill=dark?navy:'#FFFFFF';if(title)txt(s,title,56,42,1168,70,46,dark?'#FFFFFF':ink,true);s.speakerNotes.text=`建议 ${seconds} 秒\n\n${script}\n\n来源：${source}`;notes.push({slide:n,title,seconds,script});return s}
async function pic(s,name,x,y,w,h,fit='contain',crop){const f=path.isAbsolute(name)?name:a+'/'+name;const buffer=await fs.readFile(f);return s.images.add({blob:buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength),contentType:'image/png',alt:path.basename(name),fit,position:{left:x,top:y,width:w,height:h},...(crop?{crop}:{} )})}
function table(s,rows,widths,x,y,w,h,size=25){tables.push(n);const t=s.tables.add({rows:rows.length,columns:rows[0].length,left:x,top:y,width:w,height:h,columnWidths:widths,values:rows});t.borders.assign({fill:'#DFE6F3',width:1,style:'solid'});for(let r=0;r<rows.length;r++){t.rows[r].height=h/rows.length;for(let c=0;c<rows[0].length;c++){const cell=t.getCell(r,c);cell.fill=r===0?pale:'#FFFFFF';cell.text.style={typeface:font,fontSize:size,color:r===0?blue:ink,bold:r===0};}}return t}
async function video(s,file,poster,x,y,w,h){await pic(s,poster,x,y,w,h);movies.push({slide:n,file:o+'/演示视频/'+file,poster:a+'/'+poster,x,y,w,h});}
let s;
// 01 · cover
s=page('',20,'各位老师好，我们展示的是 Vibe Logisim 数字电路教学工作台。今天以全加器实验贯穿演示：教师配置任务，学生设计并提交，系统逐组评测，教师查看结果和 AI 学情报告。','项目源码；本页为电路主题插画',true);
await pic(s,'cover.png',0,0,1280,720,'cover');
txt(s,'Vibe\nLogisim',60,135,620,225,100,'#FFFFFF',true);txt(s,'数字电路教学工作台',67,396,620,62,37,'#BCD0FA');txt(s,'电路设计  /  AI 协作  /  课堂评测',68,548,690,45,25,'#90ACDF');
// 02 · actual product
s=page('电路设计与 AI 协作',45,'这是实际桌面工作台。左侧组织工程，中间编辑和仿真电路，右侧与 AI 对话。AI 可以读取当前工程、解释连接、调用编辑工具，也能在修改后撤销和保存。这里是一位全加器，输入为 A、B、Cin，输出为 S、Cout。下面进入课堂，展示同一份 circ 工程如何成为可评测的实验。','apps/workbench/src；crates/logisim-runtime；实际工作台截图');
await pic(s,'workbench-final.png',56,132,1168,513,'cover',{left:0,top:.05,right:0,bottom:.05});txt(s,'工程管理',82,651,280,40,27,blue,true);txt(s,'编辑 · 仿真 · 撤销',464,651,415,40,27,ink,true);txt(s,'AI 解释与工具编辑',916,651,340,40,27,blue,true);
// 03 · demo curriculum
s=page('数字电路课堂',35,'演示课堂有两个章节、四个关卡。第一章练习半加器和全加器，第二章完成数据选择器和数值比较器。每关都有图文说明、起始模板、测试用例和分值。学生用课堂码加入，教师可以在已有课堂中继续编辑任务和管理关卡。','线上演示课堂；deploy/classroom/acceptance-2026-11-02-assessment.md');
txt(s,'2',60,169,250,117,96,blue,true);txt(s,'个章节',65,286,240,45,30,ink,true);txt(s,'4',60,376,250,117,96,ink,true);txt(s,'个递进关卡',65,493,285,45,30,ink,true);txt(s,'半加器 → 全加器\n选择器 → 比较器',65,579,370,84,27,muted);
await pic(s,'classroom-levels.png',438,139,786,563);
// 04 · embedded actual recording
s=page('教师配置关卡',50,'播放教师配置录屏。以全加器为例：教师用 Markdown 编写说明，可以导入文字和插图。上传 circ 模板后选择输入、输出标签，并设置用例数量、每组输入和预期输出。最后两组为隐藏用例。公开用例帮助学生调试，隐藏用例用来验证设计。教师还可以上传参考电路试评，确认自己的用例与参考答案一致。','LessonEditor.tsx；线上演示课堂录屏');
txt(s,'图文说明',58,188,330,52,36,ink,true);txt(s,'Markdown 与插图',61,245,340,43,25,muted);txt(s,'circ 模板',58,358,330,52,36,ink,true);txt(s,'引脚标签与分值',61,415,340,43,25,muted);txt(s,'公开 / 隐藏用例',58,529,360,52,32,blue,true);
await video(s,'01-教师配置关卡.mp4','lesson-cases.png',439,133,789,583);
// 05 · actual end to end submission
s=page('学生打开模板并提交',55,'播放学生录屏。学生从课堂中下载模板，模板会保存到工作文件夹并自动打开。先补全逻辑门和连线，再把当前工程提交到对应关卡。本次录屏实际调用了桌面宿主与线上评测服务，结果由服务端 Logisim 运行产生。左边三个输入对应右边两个输出，提交历史和课堂绑定都能保留，学生可以继续修改和重试。','Curriculum.tsx；真实桌面宿主、线上 JVM 提交；build/simulation.json');
txt(s,'01',58,180,200,65,50,blue,true);txt(s,'打开模板',58,250,248,50,31,ink,true);txt(s,'02',58,357,200,65,50,blue,true);txt(s,'完成设计',58,427,248,50,31,ink,true);txt(s,'03',58,533,200,65,50,blue,true);txt(s,'提交评测',58,603,248,50,31,ink,true);
await video(s,'02-学生模板与提交.mp4','student-complete.png',295,125,932,582.5);
// 06 · concrete public/hidden failure
s=page('逐组评测，定位输出差异',50,'这是一份真实的失败提交：八组用例中通过四组。展开 001，可以看到 A=0、B=0、Cin=1 时，和位预期为1，实际为0。它提示学生检查 Cin 到和位的逻辑路径。学生能够看到公开用例的输入和差异；隐藏用例只反馈通过状态。全加器关卡只有全部用例通过才获得25分。正确设计已经在本次实际提交中通过8/8。','线上 demo-student-2 全加器历史；Curriculum.tsx；本次8/8实测');
txt(s,'4 / 8',60,179,400,112,88,'#E25752',true);txt(s,'用例通过',66,292,370,48,30,ink,true);txt(s,'001 进位输入',65,396,380,49,31,ink,true);txt(s,'预期 S = 1\n实际 S = 0',66,465,355,118,35,ink);txt(s,'全部通过，获得 25 分',65,622,430,45,26,blue,true);
await pic(s,'student-failed.png',513,145,711,523,'contain');
// 07 · instructor video
s=page('教师查看闯关情况与成绩',45,'播放教师视角录屏。一张矩阵可以同时看到每名学生、每个关卡的通过情况和提交次数。示例中，王小明55分，李华10分，陈晨80分。点击对应关卡可查看提交版本和失败用例，也能打开提交电路副本。成绩按当前测试版本的最佳通过记录计算，教师可以生成成绩单并复制为 CSV。','线上课堂进度和成绩单；Curriculum.tsx；真实录屏');
txt(s,'逐关追踪',58,201,350,53,36,ink,true);txt(s,'通过 · 失败 · 未提交',60,262,355,43,25,muted);txt(s,'保留提交历史',58,372,350,53,36,ink,true);txt(s,'打开学生电路副本',60,433,355,43,25,muted);txt(s,'成绩单导出',58,544,350,53,36,blue,true);txt(s,'最佳通过记录计分',60,605,355,43,25,muted);
await video(s,'03-教师成绩与分析.mp4','teacher-grade.png',439,133,789,583);
// 08 · real AI report and budget
s=page('AI 学情分析',50,'教师可以选择整班或单个学生，基于电路快照、问答摘要和关卡评测证据分析。右侧是已生成的全班报告：它引用了80、55、10分的成绩，并给出全加器补练和比较器教学建议。分析按教师点击生成，证据和问题相同会复用报告。本次三位学生的报告输入1576、输出1872 tokens；这包含推理模型计入输出预算的部分。成本随证据和模型变化，系统通过总输入预算、摘录和缓存控制开销。','线上已保存 deepseek-flash 报告，2026-11-02 17:07；analysis.mts；acceptance-2026-11-02-scores.md',true);
txt(s,'电路 + 对话 + 评测',58,169,470,65,38,'#FFFFFF',true);txt(s,'定位共性困难\n查看提问方式\n生成教学建议',61,271,405,185,33,'#B9C9E7');txt(s,'1,576 / 1,872',58,511,435,74,45,'#79A4FF',true);txt(s,'本次报告输入 / 输出 tokens',62,591,435,42,24,'#A8BCD9');
await pic(s,'teacher-analysis-bottom.png',525,143,699,516);
// 09 · nonfunctional tests
s=page('非功能验证',50,`这一页覆盖老师要求的效率、安全性和健壮性。对实际公网课堂概览接口预热5次，再顺序读取30次，本次p95为${perf.p95}毫秒。安全性包括教师密钥留在服务器、课堂成员鉴权和隐藏用例脱敏。评测在独立 JVM 中运行，拒绝外部库，设置256MB堆内存与15秒超时。已有工作台32项UI场景和课堂服务8项测试通过，详细输入和通过条件在附录与用例表中。`,`接口响应实测.json；native-grader.mts；acceptance-2026-11-02-scores.md`);
txt(s,String(perf.p95),58,171,500,125,104,blue,true);txt(s,'ms  /  公网接口 p95',64,300,570,48,31,ink,true);txt(s,'30 次顺序鉴权读取',65,366,565,44,26,muted);txt(s,'32',60,486,230,90,72,ink,true);txt(s,'UI 场景通过',65,582,270,45,27,muted);txt(s,'8',348,486,200,90,72,ink,true);txt(s,'服务测试通过',351,582,290,45,27,muted);
txt(s,'安全性',712,179,470,50,34,ink,true);txt(s,'成员鉴权 · 密钥代理 · 隐藏用例脱敏',714,242,470,80,28,muted);txt(s,'健壮性',712,369,470,50,34,ink,true);txt(s,'独立评测进程\n非法电路拒绝\n超时与内存限制',714,432,470,149,29,muted);
// 10 · native editable architecture and data organization
s=page('关键技术与数据组织',50,'界面采用 React19、TypeScript 和 Zustand，Tauri2提供桌面外壳。Rust和Tokio宿主管理工程、文件与修订，Java Logisim负责电路语义和仿真。Node.js AI运行时调用受控工具，自动布局采用ELK。独立课堂服务运行在Node24上，SQLite保存用户、课堂、关卡、提交和分析报告，HTTPS连接师生桌面端，服务通过Nginx和systemd部署。提交评测会另启独立JVM。','package manifests；Cargo.toml；docs/architecture.md；packages/classroom/src');
const arch=[['桌面界面','React 19 · TypeScript · Zustand',58,155,555,100],['工程与修订','Tauri 2 · Rust · Tokio',58,309,555,100],['电路仿真','Java · Logisim 兼容运行时',58,463,555,100],['AI 与自动布局','Node.js · pi-agent · ELK',704,155,520,100],['课堂与评测服务','Node.js 24 · SQLite · 独立 JVM',704,309,520,100]];
for(const [t,d,x,y,w,h] of arch){box(s,x,y,w,h,pale);txt(s,t,x+22,y+14,w-44,40,29,ink,true);txt(s,d,x+22,y+57,w-44,32,23,muted)}
for(const y of [255,409])box(s,334,y,2,54,'#B2C4E8');box(s,613,355,91,2,blue);txt(s,'HTTPS',623,315,89,36,17,blue,true);txt(s,'账号 → 课堂 → 关卡 → 提交',705,478,520,45,28,ink,true);txt(s,'电路快照 · 对话记录 · 分析报告',705,546,520,70,26,muted);txt(s,'Nginx / HTTPS / systemd',59,616,1160,40,25,blue,true);
// 11 · production LOC and agreed role allocation
s=page('代码工作量与三人协作',50,`按${stats.commit.slice(0,7)}版本重新统计，项目主体逻辑有效代码为${stats.logic}行，覆盖${stats.files}个生产源文件。统计去除注释、空行，排除脚本、测试、生成代码、依赖和配置，CSS与HTML另计。相对上游95acbb7的逻辑净增为${stats.logic-stats.baselineLogic}行，不把开源原有代码算成团队新增。三人分工展示安排为：A负责核心编辑与仿真，B负责AI、课堂和评测，C负责测试与发布。建议按45%、35%、20%呈现工作分配，正式汇报前填入姓名并由成员核对。`,`代码量统计.json、代码量明细.csv；Git fa910ae / 95acbb7；用户授权安排三人分工`);
txt(s,stats.logic.toLocaleString('en-US'),58,181,590,125,92,blue,true);txt(s,'项目主体逻辑有效行',64,315,585,47,31,ink,true);txt(s,`${stats.files} 个生产源文件`,65,395,575,43,27,muted);txt(s,`相对上游净增 ${(stats.logic-stats.baselineLogic).toLocaleString('en-US')} 行`,65,456,575,50,27,ink);txt(s,`CSS ${stats.css.toLocaleString('en-US')}  /  HTML ${stats.markup}`,65,541,575,40,24,muted);
table(s,[['分工安排','负责内容'],['成员 A · 45%','编辑内核、仿真与集成'],['成员 B · 35%','AI、课堂管理与关卡评测'],['成员 C · 20%','测试、官网发布与演示']],[245,355],650,178,574,339,24);txt(s,'功能分支 → PR 审查 → 回归验收',655,558,565,60,27,blue,true);txt(s,'统计范围：生产源码，去注释与空行，排除脚本、测试和生成代码',65,641,1140,37,21,muted);
// 12 · intentional feedback placeholder, no invented reviews
s=page('真实用户反馈',30,'这一页保留真实用户反馈评分项。目前先预留，正式答辩前邀请同学和任课教师试用，按三个问题记录：能否独立完成实验、评测反馈是否帮助纠错、教师能否定位困难。请替换为实际试用人数、原话、问题与修复复测截图。演示账号和预设成绩不计作真实用户反馈。','课程评分要求：真实用户反馈5%；待实际试用补充');
txt(s,'试用记录待补充',59,160,1100,75,51,blue,true);txt(s,'试用对象',60,305,340,48,31,ink,true);txt(s,'学生 / 教师\n人数与试用时间',62,374,342,105,29,muted);txt(s,'原话与体验',466,305,340,48,31,ink,true);txt(s,'独立完成实验\n评测反馈与上手感受',468,374,350,105,29,muted);txt(s,'问题与改进',872,305,340,48,31,ink,true);txt(s,'发现的问题\n修改与复测结果',874,374,340,105,29,muted);txt(s,'此页替换为真实反馈与截图',62,599,1100,48,29,muted);
// 13 · release / finish, website screenshot
s=page('发布与体验',25,'官网提供软件介绍、截图、使用说明、下载和评论入口。演示版通过桌面软件连接线上课堂服务。正式交叉评估前，需要将官网公开下载更新到当前包含评测功能的安装包，并确认同学能够下载安装。我们的演示到这里，谢谢各位老师，欢迎提问。','https://lovej.site/vibe-logisim/；公网release.json当前2026-10-30版本；本地新版安装包见交付清单',true);
txt(s,'Vibe Logisim',59,169,575,86,59,'#FFFFFF',true);txt(s,'电路设计 · AI 协作\n课堂组织 · 自动评测',63,294,541,122,35,'#C4D3EE');txt(s,'lovej.site/vibe-logisim',64,480,550,52,31,'#79A4FF',true);txt(s,'谢谢，欢迎提问',64,609,550,51,30,'#FFFFFF',true);await pic(s,'website.png',650,166,574,402);
// 14 · functional test cases
s=page('附录 · 功能演示用例',0,'功能用例准备页。全加器输入端口A、B、Cin，输出S、Cout。错误版本预期4/8通过，正确版本预期8/8通过。其余用例按表执行，随附CSV可填写实测结果。','本次录屏、线上示例课堂；验收记录');
table(s,[['用例','操作','通过条件'],['F01 设计与仿真','打开全加器，修改、撤销、保存','工程可重开，八组真值一致'],['F02 发布关卡','上传图文、模板，设置8组用例','学生看到说明、模板和6组公开用例'],['F03 打开模板','学生点击下载模板并打开','文件保存本地，工作台显示电路'],['F04 提交评测','分别提交错误版、正确版','分别4/8失败、8/8通过，历史保留'],['F05 教师查看','查看矩阵、提交副本、生成成绩单','55 / 10 / 80，CSV与矩阵一致'],['F06 AI 分析','打开整班已有报告','引用评测与问答，显示教学建议']],[218,468,482],56,150,1168,490,24);
// 15 · nonfunctional test plan and environment
s=page('附录 · 非功能用例与实测条件',0,`本次HTTPS性能环境：Windows桌面到lovej.site公网，3名示例学生、一个课堂，预热5次、顺序鉴权读取30次。p50=${perf.p50}ms、p95=${perf.p95}ms。它是接口延迟样本，不是多人并发压测。安全和健壮性用例见既有服务测试与部署验收。本页是答辩现场补充，不占主讲时间。`,'接口响应实测.json；packages/classroom/test；部署验收记录');
table(s,[['维度','测试输入 / 操作','预期行为'],['权限','学生访问其他课堂或教师接口','拒绝访问，不返回他班数据'],['隐私','学生读取隐藏测试用例与结果','返回隐藏数量、通过状态'],['异常','上传无效XML、外部库或递归电路','拒绝评测，返回可理解错误'],['资源','提交耗时电路，触发限制','独立进程，256MB堆与15秒超时'],['效率','公网课堂概览，30次顺序读取',`p50 ${perf.p50} ms / p95 ${perf.p95} ms`],['AI 成本','相同证据与问题重复请求','复用已有报告']],[170,525,473],56,150,1168,465,24);txt(s,'性能样本：1 个课堂 / 3 名学生 / 预热 5 次 / 公网 HTTPS',62,638,1160,40,23,muted);
// 16 · detailed count
s=page('附录 · 主体代码量统计',0,`版本${stats.commit}。基线95acbb7。每个源文件的计数和语言见随附CSV。主体逻辑不含CSS/HTML，生产文件数包括单列的样式与HTML。Git原仓库已有代码包含在总量中，团队新增净量另列，净增不能替代逐人实际投入统计。`,'代码量统计.json / 代码量明细.csv / count_source.py');
table(s,[['生产模块','逻辑有效行'],...Object.entries(stats.modules).map(([k,v])=>[k,v.toLocaleString('en-US')]),['合计',stats.logic.toLocaleString('en-US')]],[780,388],56,140,1168,492,22);txt(s,'排除 scripts、tests、generated、vendor、配置、依赖与 Rust 测试模块',62,648,1160,38,21,muted);
await fs.mkdir(b+'/slides',{recursive:true});await (await PresentationFile.exportPptx(p)).save(b+'/candidate-base.pptx');
for(let i=0;i<p.slides.items.length;i++){const png=await p.export({slide:p.slides.items[i],format:'png',scale:1});await fs.writeFile(b+'/slides/'+String(i+1).padStart(2,'0')+'.png',new Uint8Array(await png.arrayBuffer()));console.log('Rendered',i+1)}
await fs.writeFile(b+'/montage.webp',new Uint8Array(await(await p.export({format:'webp',montage:true})).arrayBuffer()));
await fs.writeFile(b+'/media-manifest.json',JSON.stringify(movies,null,2));await fs.writeFile(b+'/deck-meta.json',JSON.stringify({tables,slides:n,font,mainSlides:13,seconds:notes.reduce((sum,v)=>sum+v.seconds,0)},null,2));
let time=0;const script=notes.map(v=>{const start=time;time+=v.seconds;const fmt=x=>String(Math.floor(x/60)).padStart(2,'0')+':'+String(x%60).padStart(2,'0');return `## ${v.slide}. ${v.title||'封面'}${v.seconds?`  ${fmt(start)}–${fmt(time)}`:'（备查）'}\n\n${v.script}`}).join('\n\n');
await fs.writeFile(o+'/9分钟逐页讲稿.md',`# Vibe Logisim 汇报讲稿\n\n主讲13页，约9分15秒。第4、5、7页含内嵌录屏，讲解时间已包含播放。第14–16页为备查附录。\n\n${script}\n`);console.log('Total',n,'slides;',time,'seconds');
