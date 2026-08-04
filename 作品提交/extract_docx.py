import zipfile
import xml.etree.ElementTree as ET
import sys
import io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

docx_path = r'C:\Users\胡慧巧\Documents\trae\qiuzhao copilot\作品提交\Offer_Copilot_迅雷AI产品创造营产品说明文档_v4.docx'
output_path = r'C:\Users\胡慧巧\Documents\trae\qiuzhao copilot\作品提交\docx_content.txt'

with zipfile.ZipFile(docx_path, 'r') as z:
    with z.open('word/document.xml') as f:
        content = f.read()

tree = ET.fromstring(content)
ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}

paragraphs = tree.findall('.//w:p', ns)

lines = []
for i, p in enumerate(paragraphs):
    texts = p.findall('.//w:t', ns)
    line = ''.join([t.text for t in texts if t.text])
    if line.strip():
        lines.append(f'[P{i}] {line}')

with open(output_path, 'w', encoding='utf-8') as f:
    f.write('\n'.join(lines))

print(f'Extracted {len(lines)} paragraphs to {output_path}')
