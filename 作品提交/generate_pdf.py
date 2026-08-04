from fpdf import FPDF
from fpdf.enums import RenderStyle, Corner
import os

BASE_DIR = r"C:\Users\胡慧巧\Documents\trae\qiuzhao copilot\作品提交"
OUTPUT_PATH = os.path.join(BASE_DIR, "Offer_Copilot_终版路演PDF.pdf")

# Colors
DARK = (15, 23, 42)
DARK2 = (30, 41, 59)
SLATE = (71, 85, 105)
LIGHT_SLATE = (148, 163, 184)
ORANGE = (245, 158, 11)
ORANGE_DARK = (217, 119, 6)
BLUE = (14, 165, 233)
PURPLE = (139, 92, 246)
GREEN = (20, 184, 166)
BG_LIGHT = (248, 250, 252)
WHITE = (255, 255, 255)

class PDF(FPDF):
    def __init__(self):
        super().__init__(orientation='L', unit='mm', format='A4')
        self.set_auto_page_break(False)
        self.add_font('yahei', '', r'C:\Windows\Fonts\msyh.ttc')
        self.add_font('yahei', 'B', r'C:\Windows\Fonts\msyhbd.ttc')
        self.margin_left = 18
        self.margin_top = 14
        self.page_w = 297
        self.page_h = 210

def draw_gradient_bg(pdf, color1, color2):
    """Simulate gradient with multiple thin rectangles"""
    steps = 60
    for i in range(steps):
        ratio = i / steps
        r = int(color1[0] * (1 - ratio) + color2[0] * ratio)
        g = int(color1[1] * (1 - ratio) + color2[1] * ratio)
        b = int(color1[2] * (1 - ratio) + color2[2] * ratio)
        pdf.set_fill_color(r, g, b)
        pdf.rect(0, pdf.page_h * i / steps, pdf.page_w, pdf.page_h / steps + 0.5, 'F')

def add_footer(pdf, page_num, total=12):
    pdf.set_y(pdf.page_h - 12)
    pdf.set_draw_color(226, 232, 240)
    pdf.line(pdf.margin_left, pdf.page_h - 16, pdf.page_w - pdf.margin_left, pdf.page_h - 16)
    pdf.set_font('yahei', 'B', 9)
    pdf.set_text_color(*DARK)
    pdf.set_x(pdf.margin_left)
    pdf.cell(0, 5, 'Offer Copilot', ln=0)
    pdf.set_x(-30)
    pdf.set_text_color(*LIGHT_SLATE)
    pdf.cell(0, 5, f'{page_num:02d} / {total}', ln=0, align='R')

def section_header(pdf, label, title, desc=None):
    pdf.set_font('yahei', 'B', 10)
    pdf.set_text_color(*ORANGE)
    pdf.cell(0, 6, label, ln=True)
    pdf.set_font('yahei', 'B', 24)
    pdf.set_text_color(*DARK)
    pdf.cell(0, 12, title, ln=True)
    if desc:
        pdf.set_font('yahei', '', 11)
        pdf.set_text_color(*SLATE)
        pdf.multi_cell(0, 6, desc)
        pdf.ln(2)

def rounded_rect(pdf, x, y, w, h, r, fill_color=None, stroke_color=None):
    pdf.set_fill_color(*fill_color) if fill_color else None
    if stroke_color:
        pdf.set_draw_color(*stroke_color)
    if fill_color and stroke_color:
        style = RenderStyle.DF
    elif fill_color:
        style = RenderStyle.F
    else:
        style = RenderStyle.D
    corners = (Corner.TOP_LEFT, Corner.TOP_RIGHT, Corner.BOTTOM_LEFT, Corner.BOTTOM_RIGHT)
    pdf._draw_rounded_rect(x, y, w, h, style, corners, r)

def card(pdf, x, y, w, h, title, text, icon=None, color=(255,255,255), title_color=DARK, text_color=SLATE):
    rounded_rect(pdf, x, y, w, h, 4, fill_color=color, stroke_color=(226,232,240))
    pdf.set_xy(x + 5, y + 5)
    if icon:
        pdf.set_font('yahei', 'B', 16)
        pdf.set_text_color(*DARK)
        pdf.cell(0, 8, icon, ln=True)
    pdf.set_xy(x + 5, y + (18 if icon else 8))
    pdf.set_font('yahei', 'B', 13)
    pdf.set_text_color(*title_color)
    pdf.cell(w - 10, 7, title, ln=True)
    pdf.set_xy(x + 5, y + (27 if icon else 16))
    pdf.set_font('yahei', '', 10)
    pdf.set_text_color(*text_color)
    pdf.multi_cell(w - 10, 5, text)

def main():
    pdf = PDF()

    # Page 1: Cover
    pdf.add_page()
    draw_gradient_bg(pdf, DARK, DARK2)
    # Badge
    pdf.set_xy(0, 42)
    pdf.set_font('yahei', 'B', 11)
    pdf.set_text_color(*ORANGE)
    badge_text = '迅雷校园 AI 产品创造营 · 创新 AI 工具赛道'
    bw = pdf.get_string_width(badge_text) + 20
    pdf.set_x((pdf.page_w - bw) / 2)
    rounded_rect(pdf, (pdf.page_w - bw) / 2, 40, bw, 10, 5, fill_color=(66, 48, 24), stroke_color=(120, 90, 40))
    pdf.set_xy((pdf.page_w - bw) / 2, 41)
    pdf.cell(bw, 8, badge_text, align='C')
    # Title
    pdf.set_y(62)
    pdf.set_font('yahei', 'B', 52)
    pdf.set_text_color(*WHITE)
    pdf.cell(0, 20, 'Offer Copilot', align='C')
    pdf.ln(4)
    pdf.set_font('yahei', '', 22)
    pdf.set_text_color(203, 213, 225)
    pdf.cell(0, 12, 'AI 驱动的秋招求职 Agent', align='C')
    pdf.ln(8)
    pdf.set_font('yahei', '', 14)
    pdf.set_text_color(148, 163, 184)
    pdf.multi_cell(0, 7, '把散落各处的招聘信息，变成一个持续更新的 Offer 工作台', align='C')
    # QR section
    qr_size = 35
    qr_x = (pdf.page_w - qr_size - 90) / 2
    qr_y = 125
    rounded_rect(pdf, qr_x - 5, qr_y - 5, qr_size + 100, qr_size + 10, 8, fill_color=(50, 55, 70), stroke_color=(80, 88, 110))
    pdf.image(os.path.join(BASE_DIR, 'demo_qrcode.png'), qr_x, qr_y, qr_size, qr_size)
    pdf.set_xy(qr_x + qr_size + 10, qr_y + 8)
    pdf.set_font('yahei', '', 10)
    pdf.set_text_color(148, 163, 184)
    pdf.cell(0, 6, '扫码体验 Demo')
    pdf.set_xy(qr_x + qr_size + 10, qr_y + 17)
    pdf.set_font('yahei', 'B', 13)
    pdf.set_text_color(*ORANGE)
    pdf.cell(0, 7, 'offer-copilot.vercel.app/?mode=demo')
    # Footer
    pdf.set_y(190)
    pdf.set_font('yahei', '', 11)
    pdf.set_text_color(100, 116, 139)
    pdf.cell(0, 8, '单人参赛 · 面向在校大学生的智能求职助手 · 2026', align='C')

    # Page 2: Problem & Insight
    pdf.add_page()
    pdf.set_fill_color(*WHITE)
    pdf.rect(0, 0, pdf.page_w, pdf.page_h, 'F')
    section_header(pdf, 'USER INSIGHT', '秋招从"信息获取问题"变成"信息决策问题"',
                   '过去学生不知道有哪些岗位可以投，今天的问题变成：信息太多，不知道哪些值得关注，下一步该做什么。')
    # Highlight box
    rounded_rect(pdf, pdf.margin_left, 55, pdf.page_w - 2*pdf.margin_left, 28, 6, fill_color=(254, 243, 199), stroke_color=(245, 158, 11))
    pdf.set_xy(pdf.margin_left + 8, 60)
    pdf.set_font('yahei', 'B', 15)
    pdf.set_text_color(146, 64, 14)
    pdf.cell(0, 8, '核心洞察')
    pdf.set_xy(pdf.margin_left + 8, 70)
    pdf.set_font('yahei', '', 11)
    pdf.set_text_color(120, 53, 15)
    pdf.multi_cell(pdf.page_w - 2*pdf.margin_left - 16, 6, '招聘信息具有三个特征：来源极度分散、形式高度非结构化、机会具有强时效性。用户需要的不是信息罗列，而是决策支持与行动执行。')
    # 3 cards
    cw = (pdf.page_w - 2*pdf.margin_left - 24) / 3
    card(pdf, pdf.margin_left, 92, cw, 60, '来源极度分散',
         '微信群、QQ 群、钉钉群、公众号、招聘官网、邮件等渠道割裂，高价值信息容易在聊天流中消失。',
         color=(255,255,255))
    card(pdf, pdf.margin_left + cw + 12, 92, cw, 60, '形式非结构化',
         '大量信息存在于截图、海报、聊天文本和长图中，手动整理耗时且容易遗漏关键字段。',
         color=(255,255,255))
    card(pdf, pdf.margin_left + 2*(cw+12), 92, cw, 60, '强时效性',
         '错过截止时间会造成不可逆损失，多岗位并行推进时状态难以管理。',
         color=(255,255,255))
    # Metrics
    metrics = [('3', '核心问题'), ('6+', '信息渠道'), ('∞', '决策负担')]
    mx = 80
    for val, lab in metrics:
        pdf.set_xy(mx, 165)
        pdf.set_font('yahei', 'B', 30)
        pdf.set_text_color(*DARK)
        pdf.cell(40, 12, val, align='C')
        pdf.set_xy(mx, 180)
        pdf.set_font('yahei', '', 10)
        pdf.set_text_color(*SLATE)
        pdf.cell(40, 6, lab, align='C')
        mx += 70
    add_footer(pdf, 2)

    # Page 3: Product Solution
    pdf.add_page()
    pdf.set_fill_color(*WHITE)
    pdf.rect(0, 0, pdf.page_w, pdf.page_h, 'F')
    section_header(pdf, 'PRODUCT SOLUTION', '不只是记录岗位，而是理解求职上下文的智能助手',
                   '区别于传统 Excel 或 Notion 模板，Offer Copilot 主动参与决策，成为贯穿整个秋招周期的智能求职 Agent。')
    # Left column - core ideas
    pdf.set_xy(pdf.margin_left, 58)
    pdf.set_font('yahei', 'B', 15)
    pdf.set_text_color(*DARK)
    pdf.cell(0, 8, '核心理念')
    ideas = [
        ('1', '极低输入门槛', '用户只需复制文本或上传截图，AI 完成剩余工作'),
        ('2', 'AI 全流程驱动', '理解、提取、整理、规划均由 AI 自动完成'),
        ('3', '用户数据自主可控', '基于钉钉多维表格存储，数据透明可迁移'),
    ]
    y = 72
    for num, title, desc in ideas:
        pdf.set_xy(pdf.margin_left + 5, y)
        rounded_rect(pdf, pdf.margin_left, y - 2, 8, 8, 4, fill_color=ORANGE)
        pdf.set_font('yahei', 'B', 9)
        pdf.set_text_color(*WHITE)
        pdf.cell(8, 6, num, align='C')
        pdf.set_xy(pdf.margin_left + 16, y - 1)
        pdf.set_font('yahei', 'B', 12)
        pdf.set_text_color(*DARK)
        pdf.cell(0, 6, title)
        pdf.set_xy(pdf.margin_left + 16, y + 6)
        pdf.set_font('yahei', '', 10)
        pdf.set_text_color(*SLATE)
        pdf.multi_cell(110, 5, desc)
        y += 26
    # Right column - features
    pdf.set_xy(pdf.page_w/2 + 8, 58)
    pdf.set_font('yahei', 'B', 15)
    pdf.set_text_color(*DARK)
    pdf.cell(0, 8, '三大核心功能')
    features = [
        ('AI 新增机会', '自动提取公司、岗位、DDL、内推码、城市等关键字段，截图也能识别。'),
        ('机会管理看板', '统一管理岗位状态，支持搜索、筛选、查看原文，避免漏投。'),
        ('AI 求职计划', '根据截止日期、岗位匹配度和当前进度生成可解释的每日任务。'),
    ]
    fy = 72
    fw = pdf.page_w/2 - pdf.margin_left - 8
    for title, desc in features:
        rounded_rect(pdf, pdf.page_w/2 + 8, fy, fw, 34, 5, fill_color=(255,255,255), stroke_color=(226,232,240))
        pdf.set_xy(pdf.page_w/2 + 14, fy + 6)
        pdf.set_font('yahei', 'B', 12)
        pdf.set_text_color(*DARK)
        pdf.cell(0, 6, title)
        pdf.set_xy(pdf.page_w/2 + 14, fy + 15)
        pdf.set_font('yahei', '', 10)
        pdf.set_text_color(*SLATE)
        pdf.multi_cell(fw - 12, 5, desc)
        fy += 40
    add_footer(pdf, 3)

    # Page 4: AI Native
    pdf.add_page()
    pdf.set_fill_color(*WHITE)
    pdf.rect(0, 0, pdf.page_w, pdf.page_h, 'F')
    section_header(pdf, 'AI NATIVE', '用 AI 重构求职信息处理流程',
                   '不是在传统招聘工具上增加 AI 接口，而是从输入、理解、整理到决策全链路重新设计。')
    # Comparison boxes
    box_w = (pdf.page_w - 2*pdf.margin_left - 16) / 2
    # Traditional
    rounded_rect(pdf, pdf.margin_left, 58, box_w, 62, 7, fill_color=(241, 245, 249), stroke_color=(203, 213, 225))
    pdf.set_xy(pdf.margin_left + 10, 65)
    pdf.set_font('yahei', 'B', 14)
    pdf.set_text_color(*DARK)
    pdf.cell(0, 8, '传统流程')
    items_t = ['看到信息', '手动复制', 'Excel 整理', '手动维护状态', '自己判断优先级']
    y = 80
    for item in items_t:
        pdf.set_xy(pdf.margin_left + 14, y)
        pdf.set_font('yahei', '', 11)
        pdf.set_text_color(*SLATE)
        pdf.cell(0, 6, '• ' + item)
        y += 9
    # Agent
    rounded_rect(pdf, pdf.margin_left + box_w + 16, 58, box_w, 62, 7, fill_color=(239, 246, 255), stroke_color=(147, 197, 253))
    pdf.set_xy(pdf.margin_left + box_w + 26, 65)
    pdf.set_font('yahei', 'B', 14)
    pdf.set_text_color(30, 64, 175)
    pdf.cell(0, 8, 'Agent 流程')
    items_a = ['输入任意格式信息', 'AI 理解语义和图像', '自动沉淀结构化资产', '持续追踪状态', '主动推荐行动']
    y = 80
    for item in items_a:
        pdf.set_xy(pdf.margin_left + box_w + 30, y)
        pdf.set_font('yahei', '', 11)
        pdf.set_text_color(30, 58, 138)
        pdf.cell(0, 6, '• ' + item)
        y += 9
    # 3 capability cards
    cw = (pdf.page_w - 2*pdf.margin_left - 24) / 3
    card(pdf, pdf.margin_left, 130, cw, 55, '多模态招聘信息理解',
         '文本模型 + 视觉模型协同，实现招聘截图、海报、文字信息的统一理解。', color=(255,255,255))
    card(pdf, pdf.margin_left + cw + 12, 130, cw, 55, '求职机会动态实体关联',
         'AI 判断同一公司的新进展是否属于同一流程，岗位记录从静态名片变成动态进程。', color=(255,255,255))
    card(pdf, pdf.margin_left + 2*(cw+12), 130, cw, 55, 'AI 求职决策规划',
         '结合截止日期、岗位匹配度、当前进度生成可解释的每日任务建议。', color=(255,255,255))
    add_footer(pdf, 4)

    # Page 5: Architecture
    pdf.add_page()
    pdf.set_fill_color(*WHITE)
    pdf.rect(0, 0, pdf.page_w, pdf.page_h, 'F')
    section_header(pdf, 'ARCHITECTURE', '四层架构，核心链路已跑通',
                   '整体采用"输入层 → AI 解析层 → 数据层 → 应用层"架构，Demo 已完整覆盖招聘输入到任务规划的闭环。')
    # 4 layers
    layer_w = (pdf.page_w - 2*pdf.margin_left - 48) / 4
    layers = [
        ('输入层', ['文本粘贴', '截图上传', '岗位链接', '邮件 / 公众号']),
        ('AI 解析层', ['DeepSeek API', 'Qwen-VL 视觉', '实体提取', '去重与关联']),
        ('数据层', ['钉钉多维表格', '用户工作空间', '自动同步', '用户自主可控']),
        ('应用层', ['Next.js 14 + TS', '岗位看板', 'AI 计划', 'Vercel 部署']),
    ]
    x = pdf.margin_left
    for title, items in layers:
        rounded_rect(pdf, x, 60, layer_w, 75, 7, fill_color=(255,255,255), stroke_color=(226,232,240))
        pdf.set_xy(x, 68)
        pdf.set_font('yahei', 'B', 13)
        pdf.set_text_color(*DARK)
        pdf.cell(layer_w, 8, title, align='C')
        pdf.set_draw_color(241, 245, 249)
        pdf.line(x + 8, 80, x + layer_w - 8, 80)
        y = 88
        for item in items:
            pdf.set_xy(x, y)
            pdf.set_font('yahei', '', 10)
            pdf.set_text_color(*SLATE)
            pdf.cell(layer_w, 6, item, align='C')
            y += 10
        if title != '应用层':
            pdf.set_xy(x + layer_w + 4, 92)
            pdf.set_font('yahei', 'B', 18)
            pdf.set_text_color(203, 213, 225)
            pdf.cell(8, 8, '→', align='C')
        x += layer_w + 16
    # Tech stack
    tech = [('Next.js 14', 'TypeScript'), ('DeepSeek API', '文本解析'), ('Qwen-VL', '图像识别'), ('Vercel', '部署托管')]
    tw = (pdf.page_w - 2*pdf.margin_left - 36) / 4
    tx = pdf.margin_left
    for title, sub in tech:
        rounded_rect(pdf, tx, 150, tw, 32, 6, fill_color=(255,255,255), stroke_color=(226,232,240))
        pdf.set_xy(tx, 157)
        pdf.set_font('yahei', 'B', 12)
        pdf.set_text_color(*DARK)
        pdf.cell(tw, 7, title, align='C')
        pdf.set_xy(tx, 166)
        pdf.set_font('yahei', '', 9)
        pdf.set_text_color(*SLATE)
        pdf.cell(tw, 6, sub, align='C')
        tx += tw + 12
    add_footer(pdf, 5)

    # Page 6: Workflow
    pdf.add_page()
    pdf.set_fill_color(*WHITE)
    pdf.rect(0, 0, pdf.page_w, pdf.page_h, 'F')
    section_header(pdf, 'WORKFLOW', 'AI Agent 工作流：从信息输入到行动推荐',
                   '一条完整链路解决"有哪些机会、优先投哪个、今天做什么"三大核心问题。')
    # 5 workflow steps
    steps = [
        ('1', '信息输入', '复制微信群、QQ 群、邮件、公众号文本或上传招聘截图'),
        ('2', '多模态理解', 'DeepSeek 解析文本，Qwen-VL 识别图像，提取公司 / 岗位 / DDL / 内推码'),
        ('3', '实体关联', '判断是否为同公司同岗位的新进展，自动更新而非重复添加'),
        ('4', '结构化沉淀', '写入钉钉多维表格，形成可持续更新的个人求职知识库'),
        ('5', '决策与行动', '基于 DDL 和进度生成每日任务，告诉用户"今天做什么"'),
    ]
    step_w = (pdf.page_w - 2*pdf.margin_left - 48) / 5
    x = pdf.margin_left
    for num, title, desc in steps:
        rounded_rect(pdf, x, 62, step_w, 72, 7, fill_color=(255,255,255), stroke_color=(226,232,240))
        # Circle number
        pdf.set_fill_color(*ORANGE)
        pdf.ellipse(x + step_w/2 - 8, 70, 16, 16, 'F')
        pdf.set_xy(x, 71)
        pdf.set_font('yahei', 'B', 11)
        pdf.set_text_color(*WHITE)
        pdf.cell(step_w, 8, num, align='C')
        pdf.set_xy(x + 6, 92)
        pdf.set_font('yahei', 'B', 11)
        pdf.set_text_color(*DARK)
        pdf.cell(step_w - 12, 6, title, align='C')
        pdf.set_xy(x + 6, 102)
        pdf.set_font('yahei', '', 8)
        pdf.set_text_color(*SLATE)
        pdf.multi_cell(step_w - 12, 4.5, desc, align='C')
        if num != '5':
            pdf.set_xy(x + step_w + 4, 92)
            pdf.set_font('yahei', 'B', 16)
            pdf.set_text_color(203, 213, 225)
            pdf.cell(8, 8, '→', align='C')
        x += step_w + 12
    # Example box
    rounded_rect(pdf, pdf.margin_left, 145, pdf.page_w - 2*pdf.margin_left, 38, 7, fill_color=(248, 250, 252), stroke_color=(226,232,240))
    pdf.set_xy(pdf.margin_left + 10, 150)
    pdf.set_font('yahei', 'B', 12)
    pdf.set_text_color(*DARK)
    pdf.cell(0, 7, '示例场景')
    pdf.set_xy(pdf.margin_left + 10, 160)
    pdf.set_font('yahei', '', 10)
    pdf.set_text_color(*SLATE)
    pdf.multi_cell(pdf.page_w - 2*pdf.margin_left - 20, 5.5, '用户在微信群看到"百度 AI 产品经理 6 月 29 日截止 内推码 J100665"的截图，上传到 Offer Copilot 后，系统自动提取全部字段并创建机会卡片。几天后同一岗位发来笔试通知，AI 识别为同一流程并更新状态，无需手动维护。')
    add_footer(pdf, 6)

    # Page 7: Screenshots 1-2
    pdf.add_page()
    pdf.set_fill_color(*WHITE)
    pdf.rect(0, 0, pdf.page_w, pdf.page_h, 'F')
    section_header(pdf, 'PRODUCT DEMO', '功能页面预览',
                   '基于 Next.js 14 构建的 Demo 已完整实现新增机会、机会管理、求职计划、工作空间设置四大模块。')
    img_w = (pdf.page_w - 2*pdf.margin_left - 14) / 2
    img_h = 95
    # Screenshot 1
    rounded_rect(pdf, pdf.margin_left, 58, img_w, img_h + 22, 6, fill_color=(255,255,255), stroke_color=(226,232,240))
    pdf.image(os.path.join(BASE_DIR, '1.png'), pdf.margin_left + 1, 59, img_w - 2, img_h)
    pdf.set_xy(pdf.margin_left + 8, 58 + img_h + 4)
    pdf.set_font('yahei', 'B', 12)
    pdf.set_text_color(*DARK)
    pdf.cell(0, 7, 'AI 新增机会')
    pdf.set_xy(pdf.margin_left + 8, 58 + img_h + 12)
    pdf.set_font('yahei', '', 9)
    pdf.set_text_color(*SLATE)
    pdf.multi_cell(img_w - 16, 4.5, '支持粘贴文本、上传截图、选择信息来源，AI 自动提取公司 / 岗位 / DDL / 内推码')
    # Screenshot 2
    rounded_rect(pdf, pdf.margin_left + img_w + 14, 58, img_w, img_h + 22, 6, fill_color=(255,255,255), stroke_color=(226,232,240))
    pdf.image(os.path.join(BASE_DIR, '2.png'), pdf.margin_left + img_w + 15, 59, img_w - 2, img_h)
    pdf.set_xy(pdf.margin_left + img_w + 22, 58 + img_h + 4)
    pdf.set_font('yahei', 'B', 12)
    pdf.set_text_color(*DARK)
    pdf.cell(0, 7, '机会管理看板')
    pdf.set_xy(pdf.margin_left + img_w + 22, 58 + img_h + 12)
    pdf.set_font('yahei', '', 9)
    pdf.set_text_color(*SLATE)
    pdf.multi_cell(img_w - 16, 4.5, '统一查看所有岗位状态，支持搜索筛选、查看原文，避免漏投与信息混乱')
    add_footer(pdf, 7)

    # Page 8: Screenshots 3-4
    pdf.add_page()
    pdf.set_fill_color(*WHITE)
    pdf.rect(0, 0, pdf.page_w, pdf.page_h, 'F')
    section_header(pdf, 'PRODUCT DEMO', '功能页面预览（续）',
                   'AI 求职计划帮助用户从"信息罗列"跨越到"行动决策"，工作空间设置保障数据自主可控。')
    img_w = (pdf.page_w - 2*pdf.margin_left - 14) / 2
    img_h = 95
    # Screenshot 3
    rounded_rect(pdf, pdf.margin_left, 58, img_w, img_h + 22, 6, fill_color=(255,255,255), stroke_color=(226,232,240))
    pdf.image(os.path.join(BASE_DIR, '3.png'), pdf.margin_left + 1, 59, img_w - 2, img_h)
    pdf.set_xy(pdf.margin_left + 8, 58 + img_h + 4)
    pdf.set_font('yahei', 'B', 12)
    pdf.set_text_color(*DARK)
    pdf.cell(0, 7, 'AI 求职计划')
    pdf.set_xy(pdf.margin_left + 8, 58 + img_h + 12)
    pdf.set_font('yahei', '', 9)
    pdf.set_text_color(*SLATE)
    pdf.multi_cell(img_w - 16, 4.5, '输入今晚可用时间，AI 综合 DDL、当前阶段、所需精力排出最值得先做的事')
    # Screenshot 4
    rounded_rect(pdf, pdf.margin_left + img_w + 14, 58, img_w, img_h + 22, 6, fill_color=(255,255,255), stroke_color=(226,232,240))
    pdf.image(os.path.join(BASE_DIR, '4.png'), pdf.margin_left + img_w + 15, 59, img_w - 2, img_h)
    pdf.set_xy(pdf.margin_left + img_w + 22, 58 + img_h + 4)
    pdf.set_font('yahei', 'B', 12)
    pdf.set_text_color(*DARK)
    pdf.cell(0, 7, '工作空间管理')
    pdf.set_xy(pdf.margin_left + img_w + 22, 58 + img_h + 12)
    pdf.set_font('yahei', '', 9)
    pdf.set_text_color(*SLATE)
    pdf.multi_cell(img_w - 16, 4.5, '基于钉钉多维表格切换 baseId，配置保存在浏览器本地，数据透明可迁移')
    add_footer(pdf, 8)

    # Page 9: Ecosystem
    pdf.add_page()
    pdf.set_fill_color(*WHITE)
    pdf.rect(0, 0, pdf.page_w, pdf.page_h, 'F')
    section_header(pdf, 'ECOSYSTEM', '与迅雷生态形成深度协同',
                   'Offer Copilot 可与迅雷浏览器、迅雷云盘、迅雷影音形成闭环，把"信息捕获—资料管理—面试复盘"串联起来。')
    # Center circle
    cx = pdf.page_w / 2
    cy = 105
    r = 28
    pdf.set_fill_color(*DARK)
    pdf.ellipse(cx - r, cy - r, 2*r, 2*r, 'F')
    pdf.set_xy(cx - r, cy - 10)
    pdf.set_font('yahei', 'B', 16)
    pdf.set_text_color(*WHITE)
    pdf.cell(2*r, 10, 'Offer', align='C')
    pdf.set_xy(cx - r, cy + 1)
    pdf.cell(2*r, 10, 'Copilot', align='C')
    pdf.set_xy(cx - r, cy + 13)
    pdf.set_font('yahei', '', 8)
    pdf.set_text_color(148, 163, 184)
    pdf.cell(2*r, 6, '智能求职 Agent', align='C')
    # 3 surrounding cards
    positions = [
        (pdf.margin_left + 15, 75, '迅雷浏览器', '通过浏览器插件识别招聘网页信息，成为高价值信息捕获入口'),
        (pdf.page_w - pdf.margin_left - 105, 75, '迅雷云盘', '结合求职资料管理，构建 AI 驱动的个人求职知识库'),
        (pdf.page_w/2 - 45, 155, '迅雷影音', '支持面试录音、视频复盘与表达训练'),
    ]
    for x, y, title, desc in positions:
        rounded_rect(pdf, x, y, 90, 45, 6, fill_color=(255,255,255), stroke_color=(226,232,240))
        pdf.set_xy(x, y + 6)
        pdf.set_font('yahei', 'B', 14)
        pdf.set_text_color(*DARK)
        pdf.cell(90, 8, title, align='C')
        pdf.set_xy(x + 8, y + 19)
        pdf.set_font('yahei', '', 10)
        pdf.set_text_color(*SLATE)
        pdf.multi_cell(74, 5, desc, align='C')
    # Connection arrows
    pdf.set_draw_color(203, 213, 225)
    pdf.set_line_width(1)
    pdf.line(cx - r - 25, cy, cx - r - 5, cy)
    pdf.line(cx + r + 5, cy, cx + r + 25, cy)
    pdf.line(cx, cy + r + 5, cx, cy + r + 25)
    pdf.set_line_width(0.2)
    # Bottom banner
    rounded_rect(pdf, pdf.margin_left, 170, pdf.page_w - 2*pdf.margin_left, 20, 6, fill_color=(239, 246, 255), stroke_color=(191, 219, 254))
    pdf.set_xy(pdf.margin_left, 175)
    pdf.set_font('yahei', 'B', 11)
    pdf.set_text_color(30, 64, 175)
    pdf.cell(pdf.page_w - 2*pdf.margin_left, 8, '协同价值：从"看到招聘信息"到"沉淀资料"再到"复盘面试"，迅雷生态可为用户提供完整的求职数字化体验。', align='C')
    add_footer(pdf, 9)

    # Page 10: Business Model
    pdf.add_page()
    pdf.set_fill_color(*WHITE)
    pdf.rect(0, 0, pdf.page_w, pdf.page_h, 'F')
    section_header(pdf, 'BUSINESS MODEL', '三层商业化路径',
                   '从 C 端订阅起步，逐步向高校、社群、企业侧延伸，构建可持续的商业闭环。')
    # Timeline cards
    tw = (pdf.page_w - 2*pdf.margin_left - 32) / 3
    timelines = [
        ('短期 · 0-12 个月', 'C 端基础免费 + 高级订阅', '基础岗位记录免费，多模态识别、AI 计划、高级筛选等能力采用订阅制，快速验证付费意愿。', ORANGE),
        ('中期 · 1-2 年', '高校与求职社群合作', '与高校就业中心、求职社群、KOL 合作，提供班级 / 社群级模板与数据看板，扩大用户基数。', BLUE),
        ('长期 · 2-3 年', '连接企业招聘需求', '基于用户求职数据画像，为企业提供精准校招触达与人才匹配服务，实现 B 端商业价值。', PURPLE),
    ]
    x = pdf.margin_left
    for phase, title, desc, color in timelines:
        rounded_rect(pdf, x, 62, tw, 70, 6, fill_color=(255,255,255), stroke_color=(226,232,240))
        pdf.set_fill_color(*color)
        pdf.rect(x, 62, tw, 3, 'F')
        pdf.set_xy(x + 8, 70)
        pdf.set_font('yahei', 'B', 10)
        pdf.set_text_color(*SLATE)
        pdf.cell(0, 6, phase)
        pdf.set_xy(x + 8, 80)
        pdf.set_font('yahei', 'B', 14)
        pdf.set_text_color(*DARK)
        pdf.multi_cell(tw - 16, 6, title)
        pdf.set_xy(x + 8, 100)
        pdf.set_font('yahei', '', 10)
        pdf.set_text_color(*SLATE)
        pdf.multi_cell(tw - 16, 5, desc)
        x += tw + 16
    # 4 bottom cards
    bottom_items = [('精准用户', '聚焦秋招大学生群体'), ('高频场景', '秋招周期持续使用'), ('渠道杠杆', '高校与社群批量获客'), ('B 端价值', '企业招聘精准连接')]
    bw = (pdf.page_w - 2*pdf.margin_left - 36) / 4
    bx = pdf.margin_left
    for title, desc in bottom_items:
        rounded_rect(pdf, bx, 148, bw, 42, 6, fill_color=(255,255,255), stroke_color=(226,232,240))
        pdf.set_xy(bx, 156)
        pdf.set_font('yahei', 'B', 12)
        pdf.set_text_color(*DARK)
        pdf.cell(bw, 7, title, align='C')
        pdf.set_xy(bx, 168)
        pdf.set_font('yahei', '', 9)
        pdf.set_text_color(*SLATE)
        pdf.cell(bw, 6, desc, align='C')
        bx += bw + 12
    add_footer(pdf, 10)

    # Page 11: Moat & Roadmap
    pdf.add_page()
    pdf.set_fill_color(*WHITE)
    pdf.rect(0, 0, pdf.page_w, pdf.page_h, 'F')
    section_header(pdf, 'MOAT & ROADMAP', '竞争壁垒与未来规划',
                   '通过场景理解、语义关联、多渠道聚合和个人知识库构建长期壁垒。')
    # Left - 4 barriers
    pdf.set_xy(pdf.margin_left, 58)
    pdf.set_font('yahei', 'B', 15)
    pdf.set_text_color(*DARK)
    pdf.cell(0, 8, '四大竞争壁垒')
    barriers = [
        ('1', '中文校招场景理解', '深度理解内推码、DDL、批次、城市等校招特有字段。'),
        ('2', 'AI 岗位语义关联', '同一公司多来源信息自动去重合并，降低维护成本。'),
        ('3', '多渠道低门槛聚合', '截图、文本、链接统一入口，贴合真实使用场景。'),
        ('4', '个人求职知识库', '长期沉淀用户求职数据，形成越用越准的个性化资产。'),
    ]
    y = 74
    for num, title, desc in barriers:
        rounded_rect(pdf, pdf.margin_left, y, pdf.page_w/2 - pdf.margin_left - 10, 26, 5, fill_color=(255,255,255), stroke_color=(226,232,240))
        pdf.set_xy(pdf.margin_left + 8, y + 5)
        pdf.set_font('yahei', 'B', 12)
        pdf.set_text_color(*DARK)
        pdf.cell(0, 6, title)
        pdf.set_xy(pdf.margin_left + 8, y + 13)
        pdf.set_font('yahei', '', 10)
        pdf.set_text_color(*SLATE)
        pdf.multi_cell(pdf.page_w/2 - pdf.margin_left - 26, 4.8, desc)
        y += 31
    # Right - roadmap
    pdf.set_xy(pdf.page_w/2 + 8, 58)
    pdf.set_font('yahei', 'B', 15)
    pdf.set_text_color(*DARK)
    pdf.cell(0, 8, '三阶段未来规划')
    roadmap = [
        ('短', '扩大用户测试', '优化识别准确率与去重逻辑，收集真实秋招反馈', ORANGE),
        ('中', '上线浏览器插件', '打通迅雷浏览器与云盘能力，构建完整生态', BLUE),
        ('长', '职业早期 AI 助手', '从秋招延伸到实习、跳槽等职业早期全场景', PURPLE),
    ]
    y = 74
    for phase, title, desc, color in roadmap:
        pdf.set_xy(pdf.page_w/2 + 12, y + 2)
        rounded_rect(pdf, pdf.page_w/2 + 10, y, 10, 10, 5, fill_color=color)
        pdf.set_font('yahei', 'B', 9)
        pdf.set_text_color(*WHITE)
        pdf.cell(10, 8, phase, align='C')
        pdf.set_xy(pdf.page_w/2 + 26, y)
        pdf.set_font('yahei', 'B', 12)
        pdf.set_text_color(*DARK)
        pdf.cell(0, 7, title)
        pdf.set_xy(pdf.page_w/2 + 26, y + 9)
        pdf.set_font('yahei', '', 10)
        pdf.set_text_color(*SLATE)
        pdf.multi_cell(pdf.page_w/2 - pdf.margin_left - 26, 5, desc)
        y += 36
    add_footer(pdf, 11)

    # Page 12: Closing
    pdf.add_page()
    draw_gradient_bg(pdf, DARK, DARK2)
    pdf.set_y(55)
    pdf.set_font('yahei', 'B', 38)
    pdf.set_text_color(*WHITE)
    pdf.cell(0, 18, '让每一次投递都更有方向', align='C')
    pdf.ln(10)
    pdf.set_font('yahei', '', 16)
    pdf.set_text_color(148, 163, 184)
    pdf.cell(0, 10, 'Offer Copilot — AI 驱动的秋招求职 Agent', align='C')
    pdf.ln(20)
    qr_size = 45
    pdf.image(os.path.join(BASE_DIR, 'demo_qrcode.png'), (pdf.page_w - qr_size)/2, pdf.get_y(), qr_size, qr_size)
    pdf.ln(qr_size + 8)
    pdf.set_font('yahei', 'B', 14)
    pdf.set_text_color(*ORANGE)
    pdf.cell(0, 8, '扫码体验 Demo', align='C')
    pdf.ln(7)
    pdf.set_font('yahei', '', 12)
    pdf.set_text_color(148, 163, 184)
    pdf.cell(0, 7, 'offer-copilot.vercel.app/?mode=demo', align='C')
    pdf.set_y(185)
    pdf.set_font('yahei', '', 11)
    pdf.set_text_color(100, 116, 139)
    pdf.cell(0, 8, '单人参赛 · 迅雷校园 AI 产品创造营 · 创新 AI 工具赛道', align='C')

    pdf.output(OUTPUT_PATH)
    print(f"PDF saved to {OUTPUT_PATH}")

if __name__ == '__main__':
    main()
