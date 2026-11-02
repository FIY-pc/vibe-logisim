# -*- coding: utf-8 -*-
"""Vibe Logisim 课程汇报 PPT 生成器。
运行：python reports/build_report_ppt.py  ->  reports/VibeLogisim_汇报.pptx
所有【填】占位处按实际情况替换后重跑即可。"""
from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE
from pptx.oxml.ns import qn
import copy

INK = RGBColor(0x1A, 0x2B, 0x4A)      # 深墨蓝
ACCENT = RGBColor(0x0E, 0x7A, 0xC4)   # 科技蓝
CYAN = RGBColor(0x14, 0xB8, 0xC4)
BG = RGBColor(0xF3, 0xF7, 0xFB)
CARD = RGBColor(0xFF, 0xFF, 0xFF)
GRAY = RGBColor(0x5A, 0x6B, 0x82)
ORANGE = RGBColor(0xE8, 0x59, 0x0C)   # 占位提示
GREEN = RGBColor(0x1F, 0x8A, 0x4C)
RED = RGBColor(0xC0, 0x39, 0x2B)
FONT = "Microsoft YaHei"

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)
BLANK = prs.slide_layouts[6]
PAGE_NO = [0]


def ea(run):
    rPr = run._r.get_or_add_rPr()
    for tag in ("a:latin", "a:ea", "a:cs"):
        e = rPr.find(qn(tag))
        if e is None:
            e = rPr.makeelement(qn(tag), {})
            rPr.append(e)
        e.set("typeface", FONT)


def box(slide, x, y, w, h, fill=None, line=None, shadow=False, round_=False):
    shp = slide.shapes.add_shape(
        MSO_SHAPE.ROUNDED_RECTANGLE if round_ else MSO_SHAPE.RECTANGLE,
        Inches(x), Inches(y), Inches(w), Inches(h))
    shp.fill.solid() if fill else shp.fill.background()
    if fill:
        shp.fill.fore_color.rgb = fill
    if line:
        shp.line.color.rgb = line
        shp.line.width = Pt(1)
    else:
        shp.line.fill.background()
    shp.shadow.inherit = False
    return shp


def text(slide, x, y, w, h, runs, size=16, color=INK, bold=False, align=PP_ALIGN.LEFT,
         anchor=MSO_ANCHOR.TOP, line_spacing=1.0, space_after=4):
    tb = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    if isinstance(runs, str):
        runs = [runs]
    if (isinstance(runs, list) and runs and all(
            isinstance(it, tuple) and len(it) == 3 and isinstance(it[0], str)
            and isinstance(it[1], bool) and isinstance(it[2], RGBColor)
            for it in runs)):
        runs = [runs]  # segments of a single paragraph
    for i, para in enumerate(runs):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        p.line_spacing = line_spacing
        p.space_after = Pt(space_after)
        if isinstance(para, list):  # one paragraph of (text, bold, color) segments
            for seg in para:
                t, b, c = (seg + (False, INK))[:3]
                r = p.add_run(); r.text = t
                r.font.size = Pt(size); r.font.color.rgb = c; r.font.bold = b
                r.font.name = FONT; ea(r)
        elif isinstance(para, tuple):  # (text, size, color, bold)
            r = p.add_run(); r.text = para[0]
            r.font.size = Pt(para[1]); r.font.color.rgb = para[2]; r.font.bold = para[3]
            r.font.name = FONT; ea(r)
        else:
            r = p.add_run(); r.text = para
            r.font.size = Pt(size); r.font.color.rgb = color; r.font.bold = bold
            r.font.name = FONT; ea(r)
    return tb


def rich(slide, x, y, w, h, paras, size=14, color=INK, space_after=6, line_spacing=1.06):
    """paras: list of list-of-(text,bold,color) segments, or str for a bullet line."""
    tb = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    for i, para in enumerate(paras):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.space_after = Pt(space_after)
        p.line_spacing = line_spacing
        segs = [(para, False, color)] if isinstance(para, str) else para
        for seg in segs:
            t, b, c = (seg + (False, color))[:3] if isinstance(seg, tuple) else (seg, False, color)
            r = p.add_run(); r.text = t
            r.font.size = Pt(size); r.font.bold = bool(b); r.font.color.rgb = c
            r.font.name = FONT; ea(r)
    return tb


def header(slide, kicker, title, weight=""):
    PAGE_NO[0] += 1
    box(slide, 0, 0, 13.333, 7.5, fill=CARD)
    box(slide, 0, 0, 13.333, 1.12, fill=BG)
    box(slide, 0.55, 0.28, 0.10, 0.62, fill=ACCENT)
    text(slide, 0.82, 0.24, 8.6, 0.35, kicker, size=13, color=ACCENT, bold=True)
    text(slide, 0.82, 0.52, 10.2, 0.55, title, size=26, color=INK, bold=True)
    if weight:
        chip = box(slide, 11.15, 0.42, 1.75, 0.5, fill=ACCENT, round_=True)
        tf = chip.text_frame
        tf.word_wrap = False
        p = tf.paragraphs[0]; p.alignment = PP_ALIGN.CENTER
        r = p.add_run(); r.text = weight
        r.font.size = Pt(13); r.font.bold = True; r.font.color.rgb = RGBColor(255, 255, 255)
        r.font.name = FONT; ea(r)
    text(slide, 0.55, 7.08, 12.2, 0.3,
         f"Vibe Logisim · 数字电路教学平台 · 第 {PAGE_NO[0]:02d} 页",
         size=10, color=GRAY)


def bullets(slide, x, y, w, items, size=14.5, gap=6):
    """items: (level, text, bold, color) or str."""
    paras = []
    for it in items:
        if isinstance(it, str):
            it = (0, it, False, INK)
        it = tuple(it)
        lv, t = it[0], it[1]
        b = it[2] if len(it) > 2 else False
        c = it[3] if len(it) > 3 else INK
        mark = "▍ " if lv == 0 else ("· " if lv == 1 else "– ")
        prefix_c = ACCENT if lv == 0 else GRAY
        paras.append([(mark, True, prefix_c), (t, b, c)])
    return rich(slide, x, y, w, 5.7, paras, size=size, space_after=gap)


def norm_segs(val):
    """str | (t,b,c) tuple | [t,b,c] single segment | list of segments."""
    if isinstance(val, str):
        return [(val, False, INK)]
    if isinstance(val, tuple):
        return [(val + (False, INK))[:3]]
    if isinstance(val, list):
        if (len(val) == 3 and isinstance(val[0], str)
                and isinstance(val[1], bool) and isinstance(val[2], RGBColor)):
            return [tuple(val)]
        out = []
        for e in val:
            out.extend(norm_segs(e))
        return out
    return [(str(val), False, INK)]


def table(slide, x, y, w, data, widths=None, header_fill=ACCENT, font_size=12,
          row_h=0.34, aligns=None, col_colors=None):
    rows, cols = len(data), len(data[0])
    gt = slide.shapes.add_table(rows, cols, Inches(x), Inches(y), Inches(w),
                                Inches(row_h * rows)).table
    if widths:
        total = sum(widths)
        for i, cw in enumerate(widths):
            gt.columns[i].width = Emu(int(Inches(w).emu * cw / total))
    for ri, row in enumerate(data):
        for ci, val in enumerate(row):
            cell = gt.cell(ri, ci)
            cell.margin_left = cell.margin_right = Inches(0.06)
            cell.margin_top = cell.margin_bottom = Inches(0.02)
            cell.vertical_anchor = MSO_ANCHOR.MIDDLE
            cell.fill.solid()
            if ri == 0:
                cell.fill.fore_color.rgb = header_fill
            elif col_colors and ci in col_colors:
                cell.fill.fore_color.rgb = col_colors[ci]
            else:
                cell.fill.fore_color.rgb = BG if ri % 2 else CARD
            tf = cell.text_frame
            tf.word_wrap = True
            p = tf.paragraphs[0]
            if aligns and ci in aligns:
                p.alignment = aligns[ci]
            for t, b, c in norm_segs(val):
                r = p.add_run(); r.text = t
                r.font.size = Pt(font_size)
                r.font.bold = b or ri == 0
                r.font.color.rgb = RGBColor(255, 255, 255) if ri == 0 else c
                r.font.name = FONT; ea(r)
    return gt


def ph(s):
    """占位标记"""
    return [("【填】", True, ORANGE), (s, False, ORANGE)]


def card(slide, x, y, w, h, title, body_items, accent=ACCENT, size=13):
    box(slide, x, y, w, h, fill=BG, line=RGBColor(0xDD, 0xE6, 0xF0), round_=True)
    box(slide, x + 0.18, y + 0.22, 0.07, 0.34, fill=accent)
    text(slide, x + 0.36, y + 0.16, w - 0.5, 0.4, title, size=15.5, color=INK, bold=True)
    rich(slide, x + 0.36, y + 0.62, w - 0.6, h - 0.75, body_items, size=size, space_after=4)


# ============================================================ 1 封面
s = prs.slides.add_slide(BLANK)
PAGE_NO[0] += 1
box(s, 0, 0, 13.333, 7.5, fill=INK)
box(s, 0, 6.9, 13.333, 0.6, fill=ACCENT)
box(s, 0.9, 1.9, 0.16, 2.75, fill=CYAN)
text(s, 1.25, 1.95, 11.0, 0.5, "课程设计项目汇报", size=17, color=CYAN, bold=True)
text(s, 1.25, 2.45, 11.4, 1.6,
     "Vibe Logisim：AI 辅助的数字电路教学平台", size=40, color=RGBColor(255, 255, 255), bold=True)
text(s, 1.25, 3.62, 11.4, 0.6,
     "桌面电路编辑 · 仿真 · AI 助教 ｜ 在线课堂 · 关卡自动评测 · 学情分析",
     size=18, color=RGBColor(0xC9, 0xD8, 0xEE))
text(s, 1.25, 4.95, 11.0, 1.2, [
    "课程：【填课程名称】        组员：【填姓名1】 【填姓名2】 【填姓名3】",
    "指导教师：【填】            汇报日期：2026 年 11 月 2 日",
], size=15, color=RGBColor(0xC9, 0xD8, 0xEE), line_spacing=1.6)

# ============================================================ 2 汇报框架
s = prs.slides.add_slide(BLANK)
header(s, "目录", "汇报框架 —— 与评价指标逐项对应", "")
data = [
    ["汇报章节", "页码", "对应评价指标与权重"],
    ["问题概述 · 需求分析", "P3–P4", ["原始需求 30% + 需求分析 70%（大项 20%）", True, ACCENT]],
    ["原型系统设计", "P5", ["原型系统设计 30%（设计大项 35%）", True, ACCENT]],
    ["概要设计 · 详细设计", "P6–P8", ["概要 30% + 详细 40%", True, ACCENT]],
    ["编码规范与代码管理 · 工作量", "P9–P10", ["编码与测试 50%（大项 30%）· Gitee/Git 管理", True, ACCENT]],
    ["测试计划 · 测试用例", "P11–P12", ["测试计划与用例 50%", True, ACCENT]],
    ["功能展示 · 演示准备 · 分工", "P13–P16", ["功能展示 + 组员分工说明", True, ACCENT]],
    ["非功能性展示", "P17", ["智能效率 · 安全性 · 报错健壮性", True, ACCENT]],
    ["主要关键技术", "P18", ["框架 / 语言 / 数据组织", True, ACCENT]],
    ["功能创意 · 用户反馈", "P19–P20", ["创意 10% + 真实用户反馈 5%", True, ACCENT]],
]
table(s, 0.9, 1.55, 11.5, data, widths=[4.4, 1.4, 5.7], font_size=13, row_h=0.44)
text(s, 0.9, 6.35, 11.5, 0.4, [("所有内容均可现场操作验证；标 ", False, GRAY),
    ("【填】", True, ORANGE), (" 处为组员信息与用户反馈待补充位。", False, GRAY)], size=13)

# ============================================================ 3 问题概述
s = prs.slides.add_slide(BLANK)
header(s, "一 · 问题概述", "真实场景的问题与原始需求", "评分项 · 原始需求 30%")
card(s, 0.9, 1.5, 5.9, 2.6, "课程教学痛点", [
    [("· ", True, GRAY), ("数字电路实验课依赖 Logisim 类软件：批改靠肉眼逐个看电路，大班课教师无法掌握每个人的过程。", False, INK)],
    [("· ", True, GRAY), ("作业抄袭难发现：缺少“运行电路比对真值表”的自动判定，只看结果文件。", False, INK)],
    [("· ", True, GRAY), ("学生调试难：接线错误不会告诉你哪里错，提问又没有助教可问。", False, INK)],
], accent=RED)
card(s, 0.9, 4.3, 5.9, 2.5, "原始需求（题目要求）", [
    [("· ", True, GRAY), ("完成覆盖需求分析、系统设计、编码测试、功能实现与用户反馈的完整软件项目。", False, INK)],
    ph("原始题目原文可粘贴于此，"),
    [("    并与 P4 需求条目一一对应。", False, ORANGE)],
], accent=GRAY)
card(s, 7.0, 1.5, 5.4, 5.3, "我们的回答：一句话", [
    [("做一个 ", False, INK), ("“桌面端电路实验 + 在线课堂评测”", True, ACCENT), (" 的教学平台：", False, INK)],
    "",
    [("① 学生在桌面端用 AI 助教搭电路、跑仿真；", False, INK)],
    [("② 教师发布图文关卡与模板，系统像“头歌”一样", False, INK), ("按隐藏用例自动判分", True, ACCENT), ("；", False, INK)],
    [("③ 全程学习过程自动同步给教师，AI 基于评测证据生成学情报告。", False, INK)],
    "",
    [("已上线真实服务：", True, GREEN), ("lovej.site/vibe-classroom", True, ACCENT)],
    [("桌面安装包 + 便携包已交付验收。", False, GRAY)],
])

# ============================================================ 4 需求分析
s = prs.slides.add_slide(BLANK)
header(s, "二 · 需求分析", "功能需求与非功能需求", "评分项 · 需求分析 70%")
d1 = [
    ["编号", "需求", "要点"],
    ["FR1", "电路编辑与仿真", "放置/连线/子电路，内置与门/触发器/运算元件，实时仿真与错误提示"],
    ["FR2", "AI 助教", "自然语言直接改电路（放置/连线/改属性），基于仿真观察纠错给建议"],
    ["FR3", "在线课堂", "教师建课堂发邀请码；学生加入后电路与对话自动同步"],
    ["FR4", "关卡评测", "图文说明+模板+公开/隐藏用例；隔离 JVM 判题，全部通过才得分"],
    ["FR5", "教师看板", "闯关矩阵、总分、成绩单 CSV、逐提交回放、AI 学情分析报告"],
    ["FR6", "分发交付", "Windows 安装包/便携包，内置 Node 与 Java，离线可用"],
]
table(s, 0.55, 1.42, 7.35, d1, widths=[0.7, 1.7, 4.9], font_size=11.5, row_h=0.52)
card(s, 8.1, 1.42, 4.75, 2.55, "非功能需求", [
    [("安全性", True, ACCENT), ("：敌意电路防护、密钥加密、越权隔离", False, INK)],
    [("健壮性", True, ACCENT), ("：幂等提交、断网重试、原子部署回退", False, INK)],
    [("性能", True, ACCENT), ("：12MB 大电路、gzip、内容去重", False, INK)],
    [("可用性", True, ACCENT), ("：中文界面、零配置分发、离线编辑", False, INK)],
], size=12.5)
card(s, 8.1, 4.15, 4.75, 2.7, "分析方法", [
    [("角色画像：", True, INK), ("学生 / 任课教师 / 管理员", False, INK)],
    [("竞品对比：", True, INK), ("头歌 EduCoder（OJ 判题）、Logisim-ITA（单机仿真）、Proteus（收费）→ 我们=桌面仿真+AI+自动判题一体", False, INK)],
    [("需求追溯：", True, INK), ("每条 FR 对应验收用例（见 P11–12）与提交记录", False, INK)],
], size=12.5)

# ============================================================ 5 原型系统设计
s = prs.slides.add_slide(BLANK)
header(s, "三 · 原型系统设计", "四个原型的渐进迭代", "评分项 · 原型设计 30%")
ys = 1.55
steps = [
    ("原型 1 · 可用的编辑器", "Logisim-ITA 电路编辑 + 原生仿真，验证“文档模型 ↔ 渲染 ↔ 仿真”闭环", CYAN),
    ("原型 2 · 会动手的助教", "接入 DeepSeek：AI 通过工具协议直接放置元件、连线、跑仿真观察结果", ACCENT),
    ("原型 3 · 在线课堂", "独立 Node 服务 + SQLite：课堂、自动同步、教师审阅、AI 学情分析", ACCENT),
    ("原型 4 · 关卡评测", "章节/关卡/模板/隐藏用例；每次提交启动隔离 JVM 真值表判题 + 计分成绩单", GREEN),
]
for i, (t1, t2, c) in enumerate(steps):
    y = ys + i * 1.34
    box(s, 0.9, y, 3.3, 1.12, fill=c, round_=True)
    text(s, 1.12, y + 0.28, 3.0, 0.6, t1, size=16, color=RGBColor(255, 255, 255), bold=True)
    box(s, 4.5, y, 7.9, 1.12, fill=BG, line=RGBColor(0xDD, 0xE6, 0xF0), round_=True)
    text(s, 4.75, y + 0.16, 7.4, 0.9, t2, size=13.5, color=INK)
    if i < 3:
        ar = s.shapes.add_shape(MSO_SHAPE.DOWN_ARROW, Inches(2.35), Inches(y + 1.12), Inches(0.4), Inches(0.22))
        ar.fill.solid(); ar.fill.fore_color.rgb = GRAY; ar.line.fill.background(); ar.shadow.inherit = False
text(s, 0.9, 6.95, 11.6, 0.35, [("每个原型都经过“本地全量回归 → 部署线上 → 公网验收”三轮验证后才进入下一阶段（验收记录已提交仓库）。", True, GRAY)], size=12.5)

# ============================================================ 6 概要设计
s = prs.slides.add_slide(BLANK)
header(s, "四 · 概要设计", "系统架构与模块划分", "评分项 · 概要设计 30%")
# 左：桌面端
box(s, 0.7, 1.5, 6.1, 4.7, fill=BG, line=ACCENT, round_=True)
text(s, 0.9, 1.58, 5.5, 0.35, "桌面端（Windows，Tauri 2）", size=15, color=ACCENT, bold=True)
mods = [
    ("React 19 + TS 前端", "编辑器画布 · 对话 · 课堂界面"),
    ("Rust 主机进程", "电路文档引擎 · 修订/撤销 · 渲染 · IPC"),
    ("Java 仿真（内置 JRE）", "Logisim-ITA 原生元件与仿真语义"),
    ("Node 24 代理运行时", "AI 回合 · 工具调用 · 密钥本机存储"),
]
for i, (t1, t2) in enumerate(mods):
    y = 2.02 + i * 1.02
    box(s, 1.0, y, 5.5, 0.88, fill=CARD, line=RGBColor(0xC7, 0xD5, 0xE5), round_=True)
    text(s, 1.25, y + 0.1, 5.1, 0.35, t1, size=13.5, color=INK, bold=True)
    text(s, 1.25, y + 0.45, 5.1, 0.35, t2, size=11.5, color=GRAY)
# 右：云端
box(s, 7.1, 1.5, 5.5, 4.7, fill=BG, line=GREEN, round_=True)
text(s, 7.3, 1.58, 5.0, 0.35, "云端课堂服务（Node 24 + SQLite）", size=15, color=GREEN, bold=True)
mods2 = [
    ("认证与课堂", "scrypt · 令牌哈希 · 角色隔离"),
    ("同步与审阅", "不可变快照 · 内容去重存储"),
    ("关卡评测", "判题队列 · 隔离 JVM · 版本化"),
    ("AI 代理", "教师密钥加密 · SSE 流式代理"),
]
for i, (t1, t2) in enumerate(mods2):
    y = 2.02 + i * 1.02
    box(s, 7.4, y, 4.9, 0.88, fill=CARD, line=RGBColor(0xC7, 0xD5, 0xE5), round_=True)
    text(s, 7.65, y + 0.1, 4.5, 0.35, t1, size=13.5, color=INK, bold=True)
    text(s, 7.65, y + 0.45, 4.5, 0.35, t2, size=11.5, color=GRAY)
ar = s.shapes.add_shape(MSO_SHAPE.LEFT_RIGHT_ARROW, Inches(6.62), Inches(3.6), Inches(0.68), Inches(0.5))
ar.fill.solid(); ar.fill.fore_color.rgb = ACCENT; ar.line.fill.background(); ar.shadow.inherit = False
text(s, 5.0, 6.35, 7.5, 0.4, "HTTPS JSON（gzip ≤12MB）· CORS 白名单 · Bearer 令牌", size=13, color=GRAY, align=PP_ALIGN.CENTER)

# ============================================================ 7 详细设计 I
s = prs.slides.add_slide(BLANK)
header(s, "五 · 详细设计 (1/2)", "电路文档：数据模型与仿真管线", "评分项 · 详细设计 40%")
bullets(s, 0.7, 1.5, 6.1, [
    (0, "circ XML ⇄ 内存模型", True, ACCENT),
    (1, "元件/导线/属性以 ID+位置建模，属性表与位宽推导兼容 Logisim 语义"),
    (1, "每次修改返回新 revision（内容摘要），读写携带修订号做并发检测（stale 即拒绝）"),
    (1, "撤销栈按“文档修订链”回放，跨进程关闭仍可恢复草稿"),
    (0, "对外契约自动生成", True, ACCENT),
    (1, "Rust 导出 Request/Response JSON Schema → 生成 TS 类型（export-contract --check 防漂移）"),
    (0, "渲染与仿真", True, ACCENT),
    (1, "画布位图光栅化、PNG 供教师预览；仿真由内置 Java 执行，输出值/振荡/错误回传前端"),
], size=14, gap=5)
d = [
    ["设计点", "方案", "解决的问题"],
    ["并发编辑", "修订号乐观锁", "覆盖丢失修改"],
    ["AI 修改", "工具协议逐项编辑", "整文件替换冲突"],
    ["大图性能", "增量视图+位图缓存", "8MB 电路卡顿"],
    ["断点恢复", "侧车状态+草稿回放", "崩溃丢工作量"],
]
table(s, 7.0, 1.6, 5.6, d, widths=[1.2, 2.0, 1.7], font_size=12, row_h=0.5)
card(s, 7.0, 4.2, 5.6, 2.6, "真实案例 · 健壮性设计", [
    [("· 斜线导线在原生加载会挂死：加载前预检拒绝并给出修改指引；", False, INK)],
    [("· Windows verbatim 路径（\\\\?\\）拼接“/”触发 os error 123：按分隔符自适应拼接（本周修复并有回归用例）。", False, INK)],
], size=12.5, accent=ORANGE)

# ============================================================ 8 详细设计 II
s = prs.slides.add_slide(BLANK)
header(s, "五 · 详细设计 (2/2)", "关卡评测管线与安全", "评分项 · 详细设计 40%")
flow = ["学生提交", "入队(幂等)", "隔离 JVM", "真值表比对", "隐藏脱敏", "计分/成绩单"]
for i, t in enumerate(flow):
    x = 0.6 + i * 2.06
    c = GREEN if i in (2, 3, 4) else ACCENT
    box(s, x, 1.5, 1.86, 0.72, fill=c, round_=True)
    text(s, x, 1.62, 1.86, 0.5, t, size=13.5, color=RGBColor(255, 255, 255), bold=True, align=PP_ALIGN.CENTER)
    if i < 5:
        ar = s.shapes.add_shape(MSO_SHAPE.RIGHT_ARROW, Inches(x + 1.86), Inches(1.68), Inches(0.2), Inches(0.36))
        ar.fill.solid(); ar.fill.fore_color.rgb = GRAY; ar.line.fill.background(); ar.shadow.inherit = False
bullets(s, 0.7, 2.55, 6.3, [
    (0, "判题沙箱（核心难点）", True, ACCENT),
    (1, "每份提交一次全新 JVM：-Xmx256m · 15s 超时 · 无网络/文件设备"),
    (1, "XML 预检：禁 DOCTYPE/外部实体；元件白名单仅内置组合逻辑库与项目内子电路（拒递归、拒 jar 外部库）；限电路/元件/导线数量与位宽"),
    (1, "按引脚标签固定输入向量→仿真至稳定→读输出；振荡判不通过"),
    (0, "版本化判分", True, ACCENT),
    (1, "内容版本 version（并发冲突）与判题版本 gradingVersion（仅用例变化时递增）分离 → 改文案不掉分"),
    (1, "计分规则：全部用例（含隐藏）通过才获得关卡分值；成绩单/矩阵/分析注入同一事实"),
], size=13.5, gap=5)
card(s, 7.35, 2.55, 5.3, 4.0, "安全设计", [
    [("密钥：", True, INK), ("教师 API Key AES-256-GCM 加密存储；学生签发独立代理凭据，真实密钥不出服务器", False, INK)],
    [("数据隔离：", True, INK), ("角色+课堂归属双重校验；隐藏用例只回通过状态，标题与数值不泄漏（有断言测试）", False, INK)],
    [("输入防护：", True, INK), ("scrypt 口令哈希 · 令牌只存摘要 · CORS 白名单 · 请求体/图片/用例数量限额", False, INK)],
    [("滥用控制：", True, INK), ("clientId 幂等重传 · 单人 3s 频控 · 全局队列 100 · 单生并发 1", False, INK)],
], size=12.5, accent=RED)

# ============================================================ 9 编码规范与代码管理
s = prs.slides.add_slide(BLANK)
header(s, "六 · 编码与测试 (1/3)", "编码规范与 Git/Gitee 管理", "评分项 · 编码 50%")
bullets(s, 0.7, 1.5, 6.2, [
    (0, "统一编码规范", True, ACCENT),
    (1, "TypeScript strict + tsc 全量类型检查（npm run check）"),
    (1, "Rust：rustfmt + clippy + cargo check --workspace；禁止 unwrap 泄漏"),
    (1, "前端/脚本统一 Prettier；提交即格式化校验"),
    (1, "Conventional Commits：feat/fix/test/docs/chore，全仓 628 次提交可追溯"),
    (0, "平台管理", True, ACCENT),
    (1, "远程仓库 + 功能分支（codex/classroom-assessment 等按特性拉分支）"),
    (1, "每次实验=一次“提交→全量测试→部署→线上验收→验收文档”闭环"),
], size=14, gap=5)
d = [
    ["仓库活动", "数值"],
    ["总提交", "628"],
    ["最近迭代周期", "10 月–11 月 · 平均 2–3 天一次功能发布"],
    ["提交示例", "feat: … / test: … / docs: 验收记录 同名提交"],
]
table(s, 7.2, 1.5, 5.4, d, widths=[1.6, 3.2], font_size=12.5, row_h=0.55)
card(s, 7.2, 3.6, 5.4, 1.6, "Gitee 使用说明", [
    ph("仓库已用 Git 全流程管理；课程要求以 Gitee 管理的，"),
    [("    在此贴 Gitee 仓库链接与提交截图。", False, ORANGE)],
], size=12.5, accent=ORANGE)
card(s, 7.2, 5.4, 5.4, 1.3, "代码质量守门", [
    [("合并前必过：check + test:classroom + test:ui + 冒烟；", False, INK)],
    [("本周 3 个缺陷均“先复现→修→补回归用例”。", False, INK)],
], size=12.5, accent=GREEN)

# ============================================================ 10 工作量
s = prs.slides.add_slide(BLANK)
header(s, "六 · 编码与测试 (2/3)", "工作量：主体程序代码行统计", "评分项 · 编码 50%")
d = [
    ["主体模块", "语言/层", "行数", "说明"],
    ["桌面 React 前端（编辑器/对话/课堂）", "TS + TSX", "40,298", "apps/workbench/src"],
    ["Rust 主机（文档引擎/渲染/IPC/仿真桥）", "Rust", "22,036", "crates/（含 73 个自动化测试）"],
    ["课堂服务 + 代理运行时 + 工具链", "Node ESM (.mts)", "28,387", "packages/* 与 scripts/*"],
    ["原生仿真与判题扩展", "Java", "6,576", "Logisim-ITA 运行时 + ClassroomGrader"],
    ["界面样式", "CSS", "7,892", "中文界面 · 明暗主题"],
    [("主体程序合计", True, ACCENT), "", ("≈ 105,000 行", True, ACCENT), "不含 node_modules、生成物与 5.8 万行生成 JSON"],
]
table(s, 0.7, 1.5, 11.9, d, widths=[4.3, 1.7, 1.3, 4.6], font_size=12.5, row_h=0.56)
bullets(s, 0.7, 5.35, 12.0, [
    (0, "配套工程资产（同样计入工作量）", True, GREEN),
    (1, "2,359 行设计/验收文档（docs/、deploy/）· 32 项 UI 生命周期场景 · 桌面与线上双端验收脚本 · 安装包/便携包构建发布线"),
    (1, "组内 3 人贡献 628 次提交（566/37/23，含协作账号）；跨 Rust / TypeScript / Node / Java 四种语言协作"),
], size=13.5, gap=5)

# ============================================================ 11 测试计划
s = prs.slides.add_slide(BLANK)
header(s, "六 · 编码与测试 (3/3)", "测试计划：四层金字塔，全部自动化", "评分项 · 测试 50%")
layers = [
    ("① 单元/集成 · Rust 73 例", "文档编辑、撤销、连线、渲染、历史；cargo test 门禁"),
    ("② 服务测试 · Node 14 例", "课堂生命周期/权限/评测 9 例 + 网关并发/脱敏/密钥等 5 例；内存 SQLite 即跑"),
    ("③ 桌面 UI 场景回归 · 32 项", "jsdom 真实组件场景：编辑竞态、课堂同步、评测全流程…；npm run test:ui"),
    ("④ 真机与线上验收", "便携包解压真实启动（IPC/Java 仿真/Node/草稿恢复）、公网 HTTPS 验收清单：权限/加密/流式/频控/幂等/清理"),
]
for i, (t1, t2) in enumerate(layers):
    y = 1.45 + i * 1.13
    box(s, 0.7, y, 12.0, 1.0, fill=BG if i % 2 == 0 else CARD, line=RGBColor(0xC7, 0xD5, 0xE5), round_=True)
    text(s, 0.95, y + 0.1, 4.2, 0.8, t1, size=14.5, color=ACCENT, bold=True)
    text(s, 5.3, y + 0.12, 7.2, 0.8, t2, size=12.5, color=INK)
text(s, 0.7, 6.15, 12.0, 0.8, [
    [("回归纪律：", True, INK), ("任何缺陷修复必须先补一条会红的用例（本周 os error 123、严格模式竞态、隐藏用例泄漏均已入库为常驻测试）。", False, INK)],
    [("真实判题即测试：", True, INK), ("全加器 8 组真值表 + 4 类恶意电路在 CI 化脚本中每次发布都重跑。", False, INK)],
], size=13.5)

# ============================================================ 12 测试用例（功能展示准备）
s = prs.slides.add_slide(BLANK)
header(s, "七 · 功能展示 (准备)", "已准备好的演示测试用例", "评分项 · 测试用例")
d = [
    ["#", "用例", "输入", "预期", "结果"],
    ["T1", "半加器真值表", "A,B ∈ 00–11 共 4 组", "S=A⊕B, C=A·B", [("✔ 通过", True, GREEN)]],
    ["T2", "全加器关卡评测", "学生电路提交 8 组（含 2 隐藏）", "8/8 passed，隐藏题面脱敏", [("✔ 通过", True, GREEN)]],
    ["T3", "错误电路判分", "输出恒 0 的电路", "failed 1/8，逐用例差异可见", [("✔ 通过", True, GREEN)]],
    ["T4", "恶意电路拒绝", "外部 jar 库/递归子电路/XXE", "拒绝评测并安全报错", [("✔ 通过", True, GREEN)]],
    ["T5", "重复提交幂等", "同 clientId 重传/3s 内二发", "返回同一记录/频控提示", [("✔ 通过", True, GREEN)]],
    ["T6", "权限隔离", "学生读他人提交、非教师改关卡", "404/403 拒绝", [("✔ 通过", True, GREEN)]],
    ["T7", "模板下载回归", "Windows verbatim 路径+中文关卡名", "正确以 \\ 拼接并打开", [("✔ 通过", True, GREEN)]],
    ["T8", "大电路同步", "2.3MB CPU 电路自动同步", "gzip 上传、去重存储成功", [("✔ 通过", True, GREEN)]],
]
table(s, 0.7, 1.45, 11.9, d, widths=[0.5, 1.9, 2.9, 2.9, 1.0], font_size=11.5, row_h=0.485)
text(s, 0.7, 5.85, 11.9, 0.9, [
    [("全部用例可当场复跑：", True, INK), ("桌面端“上传参考电路试评”、curl 走公网 API、或 npm run test:classroom / test:ui。", False, INK)],
    [("（表格类用例对应关卡说明中的 Markdown 表格渲染，同样已修复并演示。）", False, GRAY)],
], size=13)

# ============================================================ 13 功能展示①
s = prs.slides.add_slide(BLANK)
header(s, "七 · 功能展示 (1/3)", "电路编辑与实时仿真", "评分项 · 功能展示")
bullets(s, 0.7, 1.5, 6.3, [
    (0, "现场演示脚本（约 3 分钟）", True, ACCENT),
    (1, "新建工程 → 元件库放置 与门/异或门/LED/时钟"),
    (1, "水平/垂直连线，斜线被拦截并给出指引（健壮性彩蛋）"),
    (1, "点击时钟：仿真值沿导线传播，LED 实时翻转"),
    (1, "打开“全加器”示例工程，展示子电路复用"),
    (1, "关闭重开：草稿与修订自动恢复"),
    (0, "准备物料", True, GREEN),
    (1, "示例工程 4 个：门电路/全加器/触发器计数/CPU 大图"),
], size=14, gap=6)
box(s, 7.2, 1.5, 5.4, 5.1, fill=BG, line=RGBColor(0xC7, 0xD5, 0xE5), round_=True)
text(s, 7.45, 3.4, 4.9, 1.4, [
    ph("此处放编辑器截图"),
    "（元件放置 + 仿真高亮）",
    "",
    ph("可再放连线错误提示截图"),
], size=15, color=ORANGE)

# ============================================================ 14 功能展示②
s = prs.slides.add_slide(BLANK)
header(s, "七 · 功能展示 (2/3)", "在线课堂与关卡自动评测", "评分项 · 功能展示")
bullets(s, 0.7, 1.5, 6.6, [
    (0, "现场演示脚本（约 5 分钟，账号已备好）", True, ACCENT),
    (1, "学生端：登录 demo-student-1 → “章节关卡” → 打开《全加器设计》：图文+表格+模板"),
    (1, "一键“下载模板并打开” → 补两个异或门一个或门 → 本地仿真验证"),
    (1, "“提交关卡评测” → 8/8 通过（6 公开 + 2 隐藏只显示通过）→ 得 25 分"),
    (1, "先交一份漏接 Cin 的错卷：4/8 未通过，逐用例红绿对比，隐藏用例只见结果"),
    (1, "教师端：登录 demo-teacher → 闯关矩阵总分（陈晨 80 / 王小明 55 / 李华 10）→ 生成成绩单复制 CSV → 打开任一学生提交回放"),
    (0, "准备物料", True, GREEN),
    (1, "线上“数字电路课堂”（码 15D206D6C956）已含 4 关卡 3 演示学生"),
], size=13.5, gap=5)
box(s, 7.5, 1.5, 5.1, 5.1, fill=BG, line=RGBColor(0xC7, 0xD5, 0xE5), round_=True)
text(s, 7.75, 3.3, 4.6, 1.6, [
    ph("闯关矩阵/评测结果截图"),
    "",
    ph("成绩单 CSV 粘贴 Excel 效果"),
], size=15, color=ORANGE)

# ============================================================ 15 功能展示③
s = prs.slides.add_slide(BLANK)
header(s, "七 · 功能展示 (3/3)", "AI 助教与学情分析", "评分项 · 功能展示")
card(s, 0.7, 1.5, 5.9, 2.55, "对话式电路助手（学生）", [
    [("· ", True, GRAY), ("“把进位输出接一个或门” → AI 真的放置元件并连线，逐步展示工具调用", False, INK)],
    [("· ", True, GRAY), ("“进位为什么不对？” → AI 读取仿真观察与真值表定位问题", False, INK)],
    [("· ", True, GRAY), ("密钥本机存储；教师可发布课堂统一模型", False, INK)],
])
card(s, 0.7, 4.25, 5.9, 2.5, "教师 AI 学情分析", [
    [("· ", True, GRAY), ("一键生成全班报告：注入关卡评测证据+问答摘录，引用提交编号", False, INK)],
    [("· ", True, GRAY), ("线上实测：输出 1872 tokens 的中文分节报告，同证据命中缓存不再计费", False, INK)],
], accent=GREEN)
d = [
    ["现场演示", "说什么"],
    ["学生提问改电路", "展示工具行与画布同步变化"],
    ["错卷提交后问 AI", "AI 依据仿真指出漏接 Cin"],
    ["教师生成报告", "报告逐人分数与线上矩阵一致"],
]
table(s, 7.0, 1.6, 5.6, d, widths=[1.7, 3.0], font_size=12.5, row_h=0.52)
box(s, 7.0, 3.6, 5.6, 3.0, fill=BG, line=RGBColor(0xC7, 0xD5, 0xE5), round_=True)
text(s, 7.25, 4.7, 5.1, 1.2, ph("放分析报告截图"), size=15, color=ORANGE)

# ============================================================ 16 分工
s = prs.slides.add_slide(BLANK)
header(s, "七 · 功能展示 (准备)", "组员分工说明", "评分项 · 功能展示")
d = [
    ["成员", "角色", "负责模块", "代表性提交/产出"],
    [ph("姓名1"), "组长 · 架构/后端", "Rust 文档引擎 · 评测管线 · 部署", "628 次提交主力 · 判题沙箱"],
    [ph("姓名2"), "前端 · 课堂客户端", "React 编辑器画布 · 课堂/关卡 UI", "章节关卡双标签 · 成绩单"],
    [ph("姓名3"), "AI · 测试 · 文档", "代理运行时 · 测试矩阵 · 验收文档", "32 项 UI 场景 · 验收记录"],
]
table(s, 0.7, 1.55, 11.9, d, widths=[1.4, 2.1, 4.0, 3.6], font_size=12.5, row_h=0.6)
bullets(s, 0.7, 4.3, 11.9, [
    (0, "协作方式", True, ACCENT),
    (1, "按特性分支 + 逐条缺陷“复现→修复→回归用例”；实验记录全部提交在仓库 docs/ 与 deploy/ 验收文档"),
    (0, "汇报分工建议", True, GREEN),
    (1, "P3–8 架构同学 · P12–16 演示同学操作 · P17–20 测试与反馈同学；总时长 12–15 分钟"),
], size=13.5, gap=5)

# ============================================================ 17 非功能展示
s = prs.slides.add_slide(BLANK)
header(s, "八 · 非功能性展示", "智能效率 · 安全性 · 报错健壮性", "评分项 · 非功能")
quads = [
    ("智能效率", ACCENT, [
        "AI 回合中自动等待再抓取一致快照，不阻塞编辑",
        "仿真增量计算；12MB 大图 gzip + 内容去重传输",
        "分析报告相同证据命中缓存，不再调用付费模型"]),
    ("安全性", RED, [
        "敌意电路：XXE/外部库/递归引用/超限图 全部预检拒绝",
        "教师密钥 AES-256-GCM；学生只见代理凭据，泄漏面为零",
        "隐藏用例的题面与数值从不下发学生（测试断言）"]),
    ("报错与健壮性", ORANGE, [
        "统一错误码：stale 修订拒绝覆盖、409 冲突提示、429 频控",
        "提交幂等 clientId：断网重传不产生重复成绩",
        "部署原子切换：健康检查失败自动回退旧版本"]),
    ("可维护性", GREEN, [
        "接口契约由 Rust 生成 TS 类型，--check 防漂移",
        "每次发布留存在线备份 + 验收文档（仓库可查）",
        "四语言统一格式与静态检查门禁"]),
]
for i, (t, c, items) in enumerate(quads):
    x = 0.7 + (i % 2) * 6.15
    y = 1.45 + (i // 2) * 2.85
    box(s, x, y, 5.95, 2.7, fill=BG, line=RGBColor(0xC7, 0xD5, 0xE5), round_=True)
    box(s, x + 0.18, y + 0.18, 0.08, 0.34, fill=c)
    text(s, x + 0.4, y + 0.14, 4.0, 0.4, t, size=16, color=INK, bold=True)
    rich(s, x + 0.4, y + 0.6, 5.3, 2.0,
         [[("· ", True, c), (it, False, INK)] for it in items], size=12, space_after=4)

# ============================================================ 18 关键技术
s = prs.slides.add_slide(BLANK)
header(s, "九 · 主要关键技术", "框架 · 语言 · 数据组织", "评分项 · 关键技术")
d = [
    ["层次", "技术选型", "为什么选它"],
    ["桌面壳", "Tauri 2 + Rust", "安装包比 Electron 小、原生进程桥接仿真运行时"],
    ["前端", "React 19 + TypeScript(strict) + Zustand", "大量并发异步场景需要可推导的状态与类型安全"],
    ["文档引擎", "Rust 自研（circ XML 双向模型 + 修订链）", "兼容 Logisim 文件，同时支撑撤销/幂等/AI 工具编辑"],
    ["仿真", "Logisim-ITA（Java）+ 内置 JRE", "沿用高校实验的元件语义，判题与桌面仿真同源"],
    ["服务端", "Node 24（原生 fetch/sqlite）+ SQLite WAL", "零第三方依赖、单文件部署、在线备份"],
    ["判题", "隔离 JVM + XML 预检 + 向量仿真", "把不可信学生文件关进沙箱并限时限内存"],
    ["AI", "OpenAI/Anthropic/Responses 三协议代理 + 工具调用", "教师任意换模型不断档；密钥服务端加密"],
    ["数据组织", "内容摘要 revision · 内容寻址存储 · 不可变快照", "去重、并发检测与“证据可回放”都源于此"],
]
table(s, 0.7, 1.45, 11.9, d, widths=[1.1, 4.6, 5.2], font_size=11.5, row_h=0.53)
text(s, 0.7, 6.45, 11.9, 0.4, [("一句话亮点：", True, ACCENT),
    ("一套“修订号 + 内容摘要”的数据组织，同时解决了 并发编辑、AI 安全改写、提交幂等、评测证据回放 四个问题。", False, INK)], size=13.5)

# ============================================================ 19 功能创意
s = prs.slides.add_slide(BLANK)
header(s, "十 · 功能创意", "自评分：很有特色，抓眼球（90+）", "评分项 · 创意 10%")
cards = [
    ("① AI 直接动手改电路", "不是聊天机器人陪聊：AI 通过受控工具协议放置元件、连线、跑仿真并读回观察值来纠错，学生说“帮我把进位接上”，画布就变了。", ACCENT),
    ("② “头歌式”关卡评测搬进电路课", "自研隔离 JVM 判题：图文关卡 + 模板下发 + 公开/隐藏用例 + 计分成绩单，判题证据是真实仿真输出而不是贴答案。", GREEN),
    ("③ 基于评测证据的 AI 学情报告", "自动同步的学习过程 + 逐关通过事实注入模型，报告里的分数与看板 CSV 完全一致，可当场核对，杜绝 AI 编造。", ORANGE),
]
for i, (t, b, c) in enumerate(cards):
    y = 1.5 + i * 1.78
    box(s, 0.9, y, 11.6, 1.6, fill=BG, line=RGBColor(0xC7, 0xD5, 0xE5), round_=True)
    box(s, 0.9, y, 0.14, 1.6, fill=c)
    text(s, 1.3, y + 0.12, 4.4, 1.4, t, size=16, color=INK, bold=True)
    text(s, 5.6, y + 0.15, 6.8, 1.35, b, size=12.5, color=GRAY)
text(s, 0.9, 6.9, 11.6, 0.4, "三项均为已交付并可现场演示的功能，不是规划。", size=13, color=GREEN, bold=True)

# ============================================================ 20 用户反馈
s = prs.slides.add_slide(BLANK)
header(s, "十一 · 真实用户反馈", "试用与反馈记录", "评分项 · 反馈 5%")
d = [
    ["用户", "角色/场景", "反馈内容", "时间", "状态"],
    [ph("任课老师"), "数字电路实验课备课", ph("试用关卡评测与成绩单的反馈原文"), ph("月/日"), [("已采纳", True, GREEN)]],
    [ph("学生1"), "独立完成全加器关卡", ph("“不知道哪里错”→ 逐用例对比后的评价"), ph("月/日"), [("已采纳", True, GREEN)]],
    [ph("学生2"), "AI 助教纠错", ph("对“AI 直接改电路”的使用感受"), ph("月/日"), [("待办", True, ORANGE)]],
]
table(s, 0.7, 1.5, 11.9, d, widths=[1.3, 2.6, 4.6, 1.0, 1.1], font_size=12, row_h=0.56)
card(s, 0.7, 3.9, 5.85, 2.6, "已发生的真实验证", [
    [("· ", True, GRAY), ("公网真实班级流程验收：临时账号全流程 0 阻塞（记录在仓库 deploy/ 验收文档）", False, INK)],
    [("· ", True, GRAY), ("真实教师演示课堂 4 关卡 3 学生 10 次判题，报告与看板一致", False, INK)],
], accent=GREEN)
card(s, 6.75, 3.9, 5.85, 2.6, "反馈收集计划（补位）", [
    ph("现场汇报即为一次真实反馈：留二维码/表单位"),
    [("· ", True, GRAY), ("拟邀 1 位任课教师 + 5 名学生完整使用一周，回收书面反馈表", False, INK)],
], size=12.5, accent=ORANGE)

# ============================================================ 21 总结
s = prs.slides.add_slide(BLANK)
header(s, "十二 · 总结", "完成情况对照与下一步", "")
d = [
    ["评价维度", "我们的完成证据"],
    ["需求分析 20%", "6 项 FR + 4 项 NFR，全部落地并可演示（P3–4）"],
    ["设计 35%", "4 代原型 → 三层架构 → 判题管线/版本化/密钥方案详细设计（P5–8）"],
    ["编码与测试 30%", "10.5 万行主体代码 · 628 次提交 · 73+14+32 自动化用例 · 真机/公网验收"],
    ["创意 10%", "AI 动手改电路 · 隔离 JVM 隐藏用例评测 · 证据化学情报告（P19）"],
    ["反馈 5%", "公网验收记录 + 现场试用；书面反馈表回收中（P20）"],
]
table(s, 0.7, 1.5, 11.9, d, widths=[2.6, 9.3], font_size=13, row_h=0.5)
bullets(s, 0.7, 4.9, 11.9, [
    (0, "下一步", True, ACCENT),
    (1, "顺序逻辑判题（时钟/复位规则）、批量导入学生、防作弊监考模式、更多元件库（_ttl/msi）与 Linux 版"),
    (0, "交付物", True, GREEN),
    (1, "安装包/便携包（含校验和）· 在线服务与演示账号 · 全部源码与验收文档（Git 可查）"),
], size=14, gap=5)

prs.save("D:/project/vibe-logisim/reports/VibeLogisim_汇报.pptx")
print("slides:", len(prs.slides.__iter__.__self__._sldIdLst))
print("saved: reports/VibeLogisim_汇报.pptx")
