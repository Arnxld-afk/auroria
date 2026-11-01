"""Generates the Auroria UI resource pack (src/assets/auroria-ui.zip).

Targets Minecraft 1.20+: title logo, buttons (1.20.2+ sprites and the older widgets atlas),
hotbar for 1.20/1.20.1, a warm overlay on the menu panorama, and a pack icon.
"""
import io, json, os, random, zipfile
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FONT = os.path.join(ROOT, 'src/build/fonts/oxanium-800.ttf')
OUT = os.path.join(ROOT, 'src/assets/auroria-ui.zip')
rnd = random.Random(11)

ORANGE = (240, 127, 42)
ORANGE_HI = (255, 176, 104)
ORANGE_LO = (176, 78, 18)
SHADOW = (58, 24, 6)
INK = (16, 10, 6)


def jitter(c, amt=10):
    return tuple(max(0, min(255, v + rnd.randint(-amt, amt))) for v in c[:3]) + ((c[3],) if len(c) > 3 else (255,))


def png(img):
    b = io.BytesIO(); img.save(b, 'PNG'); return b.getvalue()


def text_mask(text, size, w, h, y_off=0):
    """Hard-edged (pixel) mask of the text, centred."""
    font = ImageFont.truetype(FONT, size)
    m = Image.new('L', (w, h), 0); d = ImageDraw.Draw(m)
    box = d.textbbox((0, 0), text, font=font)
    x = (w - (box[2] - box[0])) // 2 - box[0]; y = (h - (box[3] - box[1])) // 2 - box[1] + y_off
    d.text((x, y), text, font=font, fill=255)
    return m.point(lambda v: 255 if v > 110 else 0)


def logo():
    # 256x64 texture; the game draws the top 256x44 region.
    W, H = 256, 64
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    mask = text_mask('AURORIA', 40, W, 44, -2)
    px = img.load(); m = mask.load()
    depth = 4
    for d in range(depth, 0, -1):  # extrusion, darker further back
        for y in range(44):
            for x in range(W):
                if m[x, y] and 0 <= x + d < W and y + d < 44:
                    shade = tuple(int(c * (0.55 + 0.08 * (depth - d))) for c in SHADOW)
                    px[x + d, y + d] = jitter(shade + (255,), 4)
    for y in range(44):
        for x in range(W):
            if m[x, y]:
                t = y / 43
                base = tuple(int(ORANGE_HI[i] * (1 - t) + ORANGE_LO[i] * t) for i in range(3))
                px[x, y] = jitter(base + (255,), 12)
    # dark outline for contrast on any panorama
    out = img.copy(); op = out.load()
    for y in range(44):
        for x in range(W):
            if px[x, y][3] == 0 and any(0 <= x + dx < W and 0 <= y + dy < 44 and px[x + dx, y + dy][3] and m[min(W - 1, max(0, x + dx)), min(43, max(0, y + dy))]
                                         for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                op[x, y] = INK + (255,)
    return out


def button(kind):
    W, H = 200, 20
    img = Image.new('RGBA', (W, H)); px = img.load()
    fill = {'normal': (34, 24, 16), 'hover': (52, 32, 18), 'disabled': (22, 16, 12)}[kind]
    for y in range(H):
        for x in range(W):
            px[x, y] = jitter(fill + (255,), 3)
    d = ImageDraw.Draw(img)
    edge = {'normal': (10, 6, 3), 'hover': ORANGE, 'disabled': (10, 6, 3)}[kind]
    d.rectangle([0, 0, W - 1, H - 1], outline=edge + (255,))
    if kind != 'disabled':
        d.line([1, 1, W - 2, 1], fill=(255, 255, 255, 34 if kind == 'normal' else 60))
        d.line([1, H - 2, W - 2, H - 2], fill=(0, 0, 0, 90))
    if kind == 'hover':
        d.rectangle([1, 1, W - 2, H - 2], outline=ORANGE_LO + (255,))
        d.line([2, H - 3, W - 3, H - 3], fill=ORANGE + (140,))
    return img


def nine_slice():
    return json.dumps({'gui': {'scaling': {'type': 'nine_slice', 'width': 200, 'height': 20, 'border': 3}}}, indent=2).encode()


def hotbar():
    img = Image.new('RGBA', (182, 22), (0, 0, 0, 0)); d = ImageDraw.Draw(img)
    d.rectangle([0, 0, 181, 21], fill=(14, 9, 6, 210), outline=(6, 4, 2, 255))
    for i in range(9):
        x = 1 + i * 20
        d.rectangle([x + 1, 1 + 1, x + 18, 20 - 1], outline=(255, 255, 255, 26))
    return img


def selection():
    img = Image.new('RGBA', (24, 24), (0, 0, 0, 0)); d = ImageDraw.Draw(img)
    d.rectangle([0, 0, 23, 23], outline=ORANGE + (255,))
    d.rectangle([1, 1, 22, 22], outline=ORANGE_HI + (200,))
    return img


def globe(img, ox, oy, hover):
    d = ImageDraw.Draw(img)
    btn = button('hover' if hover else 'normal').crop((0, 0, 20, 20))
    img.paste(btn, (ox, oy))
    c = (244, 236, 228, 255)
    d.ellipse([ox + 5, oy + 5, ox + 14, oy + 14], outline=c)
    d.line([ox + 5, oy + 10, ox + 14, oy + 10], fill=c)
    d.line([ox + 10, oy + 5, ox + 10, oy + 14], fill=c)


def widgets():
    atlas = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
    atlas.paste(hotbar(), (0, 0))
    atlas.paste(selection(), (0, 22))
    atlas.paste(button('disabled'), (0, 46)); atlas.paste(button('normal'), (0, 66)); atlas.paste(button('hover'), (0, 86))
    globe(atlas, 0, 106, False); globe(atlas, 0, 126, True)
    return atlas


def overlay():
    W = H = 256
    img = Image.new('RGBA', (W, H)); px = img.load()
    for y in range(H):
        for x in range(W):
            t = y / (H - 1); edge = abs(x - W / 2) / (W / 2)
            a = int(40 + 120 * t * t + 50 * edge * edge)
            r = int(30 + 40 * (1 - t)); g = int(14 + 12 * (1 - t)); b = 6
            px[x, y] = (r, g, b, min(200, a))
    return img


def icon():
    S = 128; big = Image.new('RGBA', (S * 4, S * 4), (0, 0, 0, 0)); d = ImageDraw.Draw(big)
    d.rounded_rectangle([0, 0, S * 4 - 1, S * 4 - 1], radius=96, fill=(28, 18, 11, 255))
    k = S * 4 / 100
    d.polygon([(x * k * .8 + S * .4, y * k * .8 + S * .4) for x, y in [(40, 8), (60, 8), (94, 92), (72, 92), (65, 74), (35, 74), (28, 92), (6, 92)]], fill=ORANGE + (255,))
    d.polygon([(x * k * .8 + S * .4, y * k * .8 + S * .4) for x, y in [(50, 37.7), (57.4, 56), (42.6, 56)]], fill=(28, 18, 11, 255))
    return big.resize((S, S), Image.LANCZOS)


def main():
    meta = {'pack': {'pack_format': 15, 'supported_formats': [15, 99], 'min_format': 15, 'max_format': 99,
                     'description': '§6Auroria§r interface'}}
    files = {
        'pack.mcmeta': json.dumps(meta, indent=2).encode(),
        'pack.png': png(icon()),
        'assets/minecraft/textures/gui/title/minecraft.png': png(logo()),
        'assets/minecraft/textures/gui/title/background/panorama_overlay.png': png(overlay()),
        'assets/minecraft/textures/gui/widgets.png': png(widgets()),
    }
    for name, kind in (('button', 'normal'), ('button_highlighted', 'hover'), ('button_disabled', 'disabled')):
        files[f'assets/minecraft/textures/gui/sprites/widget/{name}.png'] = png(button(kind))
        files[f'assets/minecraft/textures/gui/sprites/widget/{name}.png.mcmeta'] = nine_slice()
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as z:
        for k, v in files.items():
            z.writestr(k, v)
    # previews for review
    prev = os.environ.get('PREVIEW_DIR')
    if prev:
        logo().resize((1024, 256), Image.NEAREST).save(os.path.join(prev, 'pack-logo.png'))
        sheet = Image.new('RGBA', (600, 110), (60, 40, 30, 255))
        for i, k in enumerate(('normal', 'hover', 'disabled')):
            sheet.paste(button(k).resize((400, 40 // 1 * 1), Image.NEAREST), (10, 10 + i * 32))
        sheet.save(os.path.join(prev, 'pack-buttons.png'))
    print('wrote', OUT, os.path.getsize(OUT), 'bytes')


if __name__ == '__main__':
    main()
