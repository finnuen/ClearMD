from PIL import Image, ImageDraw
import math

S = 1024  # master canvas (drawn big, then downscaled for anti-aliasing)
NAVY = (31, 42, 68, 255)
PAGE = (232, 243, 255, 255)
FOLD = (190, 214, 245, 255)
WOOD = (176, 104, 48, 255)
WOOD_HI = (206, 134, 70, 255)
BAND = (96, 62, 36, 255)
BRISTLE = (242, 168, 48, 255)
BRISTLE_DK = (214, 130, 24, 255)
GOLD = (255, 205, 70, 255)
OUT = 26

def star(d, cx, cy, r, fill, outline, w):
    pts = []
    for k in range(8):
        a = math.pi / 2 * (k / 2) - math.pi / 2
        rad = r if k % 2 == 0 else r * 0.30
        pts.append((cx + rad * math.cos(a * 1.0 * 1) , cy + rad * math.sin(a)))
    d.polygon(pts, fill=fill, outline=outline, width=w)

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# ---- page with folded top-right corner (own layout) ----
x0, y0, x1, y1 = 96, 84, 600, 940
cut = 150
page = [(x0, y0), (x1 - cut, y0), (x1, y0 + cut), (x1, y1), (x0, y1)]
d.polygon(page, fill=PAGE, outline=NAVY, width=OUT)
d.polygon([(x1 - cut, y0), (x1 - cut, y0 + cut), (x1, y0 + cut)], fill=FOLD, outline=NAVY, width=OUT - 6)

# text lines
for i, (ya, xb) in enumerate([(300, 500), (410, 500), (520, 500), (630, 440), (740, 360)]):
    d.rounded_rectangle([180, ya - 20, xb, ya + 20], radius=20, fill=NAVY)

# ---- broom on its own layer, then rotated ----
bw, bh = 460, 900
b = Image.new("RGBA", (bw, bh), (0, 0, 0, 0))
bd = ImageDraw.Draw(b)
cx = bw // 2
# handle
bd.rounded_rectangle([cx - 30, 10, cx + 30, 520], radius=30, fill=WOOD, outline=NAVY, width=OUT - 6)
bd.rounded_rectangle([cx - 12, 40, cx + 2, 480], radius=7, fill=WOOD_HI)
# ferrule band
bd.rounded_rectangle([cx - 74, 500, cx + 74, 580], radius=18, fill=BAND, outline=NAVY, width=OUT - 6)
# bristle fan
fan = [(cx - 70, 570), (cx + 70, 570), (cx + 205, 880), (cx - 205, 880)]
bd.polygon(fan, fill=BRISTLE, outline=NAVY, width=OUT - 4)
# bristle streaks
for dx in (-110, -40, 40, 110):
    bd.line([(cx + dx * 0.35, 620), (cx + dx * 1.2, 850)], fill=BRISTLE_DK, width=16)

b = b.resize((int(bw*0.86), int(bh*0.86)), Image.LANCZOS)
b = b.rotate(-36, resample=Image.BICUBIC, expand=True)  # handle toward upper-right, bristles lower-left
ccx, ccy = 610, 610
img.alpha_composite(b, (ccx - b.width // 2, ccy - b.height // 2))

# ---- sparkles ----
star(d, 800, 150, 105, GOLD, NAVY, 14)
star(d, 925, 420, 62, GOLD, NAVY, 10)
star(d, 905, 740, 82, GOLD, NAVY, 12)

img.save("master.png")
sizes = [256, 128, 64, 48, 32, 24, 16]
frames = [img.resize((s, s), Image.LANCZOS) for s in sizes]
frames[0].save("ClearMD.ico", format="ICO", sizes=[(s, s) for s in sizes], append_images=frames[1:])
img.resize((256, 256), Image.LANCZOS).save("icon256.png")
# preview sheet on white + dark
sheet = Image.new("RGBA", (256 + 20 + 128 + 20 + 64 + 20 + 32 + 20 + 16 + 40, 300), (255, 255, 255, 255))
x = 20
for s in (256, 128, 64, 32, 16):
    f = img.resize((s, s), Image.LANCZOS)
    sheet.alpha_composite(f, (x, 20))
    x += s + 20
sheet.save("preview.png")
print("ok")
