import qrcode
from qrcode.constants import ERROR_CORRECT_H

url = "https://offer-copilot.vercel.app/?mode=demo"
output_path = r"C:\Users\胡慧巧\Documents\trae\qiuzhao copilot\作品提交\demo_qrcode.png"

qr = qrcode.QRCode(
    version=5,
    error_correction=ERROR_CORRECT_H,
    box_size=20,
    border=4,
)
qr.add_data(url)
qr.make(fit=True)

img = qr.make_image(fill_color="#1a1a2e", back_color="white").convert("RGB")
img.save(output_path)

print(f"QR code saved to {output_path}")
