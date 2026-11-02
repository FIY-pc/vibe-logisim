# Vibe Logisim · 9分钟演示汇报

主讲13页，备查3页，建议9分15秒。PPT内嵌三段真实操作录屏并设置自动播放与淡化转场。output目录包含PPT、98秒动态预览、独立视频、讲稿、现场用例、反馈空表、代码明细和待补清单。

完整演示覆盖桌面编辑与AI、课堂章节、图文/circ模板、公开/隐藏用例、线上真实Logisim判题、教师矩阵、成绩单CSV和AI学情报告。仅新增汇报文件，不修改队友应用代码。

正式汇报前替换成员姓名，补真实反馈、Gitee管理记录，并将官网旧下载更新到评测版。细节见output/使用说明与待补事项.md。

## 编辑和重新生成

PPT正文、表格和技术图可在PowerPoint中编辑。视频是内嵌H.264 MP4。source目录保存Artifact Tool作者脚本与原始截图。

在本机使用Codex bundled Node和@oai/artifact-tool，将source/node_modules连接到该运行时依赖目录。设置REPORT_WORKSPACE为本目录，REPORT_ASSETS为source/assets，依次运行source/build-deck.mjs、source/polish.mjs、source/normalize-media.mjs、source/finalize.mjs。

- build-deck使用Artifact Tool构建可编辑内容。
- polish调用本机PowerPoint的原生媒体API添加自动播放和淡化转场。
- normalize仅移除PowerPoint写出的三个可选空媒体超链接relationship属性，保留嵌入视频及播放动作。
- finalize使用技能附带验证器检查包、布局、字体、原生表格和Artifact Tool导入。已存在输出时请换新文件名，验证器不会覆盖成品。

当前脚本运行时和技能位置按本机环境保存。若换电脑，修改运行时与技能路径即可。重新作者操作前按Presentations技能运行operation marker。
