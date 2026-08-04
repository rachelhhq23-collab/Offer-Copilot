from weasyprint import HTML, CSS
from weasyprint.text.fonts import FontConfiguration

html_path = r"C:\Users\胡慧巧\Documents\trae\qiuzhao copilot\作品提交\Offer_Copilot_BP.html"
pdf_path = r"C:\Users\胡慧巧\Documents\trae\qiuzhao copilot\作品提交\Offer_Copilot_终版路演PDF.pdf"

font_config = FontConfiguration()
html = HTML(filename=html_path)
html.write_pdf(pdf_path, font_config=font_config)

print(f"PDF saved to {pdf_path}")
