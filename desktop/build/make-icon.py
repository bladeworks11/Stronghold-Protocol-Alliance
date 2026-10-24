"""生成「卫戍协议：盟约」桌面客户端图标 —— 取自标题画面那枚点阵瞭望塔徽记（public/js/screens/title.js 的 EMBLEM）。

用法：  python build/make-icon.py      →  icon.png (512) · icon-256.png · icon.ico (16…256)
小尺寸（≤32px）用 2×2 合并后的粗点阵，否则 13 列圆点在 16px 下会糊成一团。
"""
from PIL import Image, ImageDraw
import os

# 与 screens/title.js 的 EMBLEM 完全一致：13 列 × 14 行
EMBLEM = [
    'XXX..XXX..XXX',
    'XXX..XXX..XXX',
    'XXXXXXXXXXXXX',
    '.XXXXXXXXXXX.',
    '..XXXXXXXXX..',
    '..XXXXXXXXX..',
    '..XXXX.XXXX..',
    '..XXXX.XXXX..',
    '..XXXXXXXXX..',
    '..XXXXXXXXX..',
    '..XXXXXXXXX..',
    '.XXXXXXXXXXX.',
    'XXXXXXXXXXXXX',
    'XXXXXXXXXXXXX',
]

BG_TOP = (13, 23, 20)
BG_BOTTOM = (6, 10, 9)
MINT = (23, 249, 183)          # --mint-500 / #17f9b7
S = 1024                        # 先画大图再缩，边缘更干净


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def coarse(grid, factor=2):
    """按 factor×factor 合并成粗点阵：块里过半是 X 就点亮（小尺寸用）。"""
    rows, cols = len(grid), len(grid[0])
    out = []
    for r in range(0, rows, factor):
        line = ''
        for c in range(0, cols, factor):
            cells = [grid[rr][cc] for rr in range(r, min(r + factor, rows)) for cc in range(c, min(c + factor, cols))]
            line += 'X' if cells.count('X') * 2 >= len(cells) else '.'
        out.append(line)
    return out


def rounded_bg(size, radius):
    bg = Image.new('RGB', (size, size), BG_TOP)
    d = ImageDraw.Draw(bg)
    for y in range(size):
        d.line([(0, y), (size, y)], fill=lerp(BG_TOP, BG_BOTTOM, y / size))
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(bg, (0, 0), mask)
    border = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(border).rounded_rectangle(
        [2, 2, size - 3, size - 3], radius=radius, outline=(46, 74, 64, 190), width=3)
    out.alpha_composite(border)
    return out


def draw_emblem(img, grid, cell_ratio, accent_at, radius=(0.30, 0.44)):
    d = ImageDraw.Draw(img)
    cols, rows = len(grid[0]), len(grid)
    cell = S * cell_ratio
    left, top = (S - cols * cell) / 2, (S - rows * cell) / 2
    for r, row in enumerate(grid):
        for c, ch in enumerate(row):
            if ch != 'X':
                continue
            cx = left + c * cell + cell / 2
            cy = top + r * cell + cell / 2
            rad = cell * (radius[0] + (r / max(1, rows - 1)) * (radius[1] - radius[0]))
            accent = (r, c) in accent_at
            if accent:
                d.ellipse([cx - rad * 1.6, cy - rad * 1.6, cx + rad * 1.6, cy + rad * 1.6],
                          fill=MINT + (48,))
                col = MINT
            else:
                amp = 200 + ((r * 13 + c) % 7) * 8
                col = (amp, min(255, amp + 12), min(255, amp + 6))
            d.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=tuple(col) + (255,))
    return img


def render(grid, cell_ratio, accent_at):
    canvas = rounded_bg(S, radius=int(S * 0.19))
    return draw_emblem(canvas, grid, cell_ratio, accent_at)


def dib_bytes(img):
    """把一张 RGBA 图编成 ICO 里用的 DIB（BITMAPINFOHEADER + BGRA 倒序 + AND 掩码）。
    Windows 外壳给快捷方式取图标时，PNG 压缩条目只在 256×256 上可靠，小尺寸要传统的 DIB，
    否则会退化成白纸图标。"""
    import struct
    img = img.convert('RGBA')
    w, h = img.size
    px = img.load()
    xor = bytearray()
    for y in range(h - 1, -1, -1):
        for x in range(w):
            r, g, b, a = px[x, y]
            xor += bytes((b, g, r, a))
    stride = ((w + 31) // 32) * 4
    and_mask = bytearray()
    for y in range(h - 1, -1, -1):
        row = bytearray(stride)
        for x in range(w):
            if px[x, y][3] == 0:
                row[x // 8] |= 0x80 >> (x % 8)
        and_mask += row
    header = struct.pack('<IiiHHIIiiII', 40, w, h * 2, 1, 32, 0, len(xor) + len(and_mask), 0, 0, 0, 0)
    return bytes(header) + bytes(xor) + bytes(and_mask)


def write_ico(path, entries):
    """自己拼一个 ICO：每个尺寸用各自的图（PIL 的 save(sizes=…) 会把同一张图缩成所有尺寸）。"""
    import struct
    entries = sorted(entries, key=lambda e: -e[0])
    header = struct.pack('<HHH', 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    blob = b''
    index = b''
    for size, data in entries:
        index += struct.pack('<BBBBHHII', size % 256, size % 256, 0, 0, 1, 32, len(data), offset + len(blob))
        blob += data
    with open(path, 'wb') as fh:
        fh.write(header + index + blob)


def main():
    import io
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)          # client/

    # 大图标：完整 13×14 点阵；小图标：2×2 合并的 7×7 粗点阵（4 颗薄荷色仍在眼睛的位置）
    fine = render(EMBLEM, 0.057, {(6, 5), (6, 7), (7, 5), (7, 7)})
    rough = render(coarse(EMBLEM), 0.106, {(3, 2), (3, 3), (4, 2), (4, 3)})

    fine.resize((512, 512), Image.LANCZOS).save(os.path.join(root, 'icon.png'))
    fine.resize((256, 256), Image.LANCZOS).save(os.path.join(root, 'icon-256.png'))

    plan = [(256, fine), (128, fine), (64, fine), (48, fine), (32, rough), (24, rough), (16, rough)]
    made = []
    entries = []
    for size, src in plan:
        img = src.resize((size, size), Image.LANCZOS)
        made.append(img)
        entries.append((size, dib_bytes(img)))   # 全部用 DIB，兼容外壳取图标
    write_ico(os.path.join(root, 'icon.ico'), entries)

    # 预览条（仅检查用）
    strip = Image.new('RGBA', (sum(i.width for i in made) + 16 * (len(made) + 1), 272), (18, 22, 21, 255))
    x = 16
    for img in made:
        strip.alpha_composite(img, (x, 272 - img.height - 8))
        x += img.width + 16
    strip.save(os.path.join(here, '_icon-preview.png'))
    print('wrote icon.png / icon-256.png / icon.ico →', root)


if __name__ == '__main__':
    main()
