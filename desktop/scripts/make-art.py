# Genera el ícono de la app (icon.ico / icon.png) y las imágenes del instalador de Windows
# a partir del ícono de la app de Android. Se corre a mano solo si cambia el ícono:
#   python3 desktop/scripts/make-art.py
# (necesita Pillow). Los archivos generados quedan en desktop/build/ y se suben al repo.
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'desktop' / 'build'
SRC = ROOT / 'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png'
PIXEL_FONT = str(ROOT / 'fonts/press-start-2p.woff2')
TEXT_FONT = str(ROOT / 'fonts/inter.woff2')
BG, BG2, ACC, TEXT, MUTED = (7, 9, 15), (22, 28, 48), (242, 179, 61), (232, 235, 243), (138, 147, 168)

OUT.mkdir(parents=True, exist_ok=True)

# el ícono de Android es pixel art de 32x32 dibujado a 6x (192 px): recupero la grilla original
src = Image.open(SRC).convert('RGBA')
grid = src.resize((32, 32), Image.NEAREST)
# las esquinas redondeadas del original quedan escalonadas en la grilla: las relleno con el fondo vecino
gp = grid.load()
for y in range(32):
    for x in range(32):
        if gp[x, y][3] < 255:
            nx, ny = x, y
            while gp[nx, ny][3] < 255: nx += 1 if nx < 16 else -1; ny += 1 if ny < 16 else -1
            gp[x, y] = gp[nx, ny][:3] + (255,)


def icon(size):
    """Ícono nítido: escala entera de la grilla y después ajuste fino, con esquinas redondeadas suaves."""
    k = max(1, -(-size * 4 // 32))
    big = grid.resize((32 * k, 32 * k), Image.NEAREST)
    im = big.resize((size, size), Image.LANCZOS) if big.size[0] != size else big
    # esquinas redondeadas con borde suave (máscara dibujada a 4x)
    m = Image.new('L', (size * 4, size * 4), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size * 4 - 1, size * 4 - 1), radius=size * 4 * 0.16, fill=255)
    m = m.resize((size, size), Image.LANCZOS)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(im, (0, 0), m)
    return out


sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
icons = [icon(s) for s in sizes]
icons[-1].save(OUT / 'icon.ico', sizes=[(s, s) for s in sizes], append_images=icons[:-1])
icon(512).save(OUT / 'icon.png')


def gradient(w, h, top, bottom):
    g = Image.new('RGB', (w, h))
    d = ImageDraw.Draw(g)
    for y in range(h):
        t = y / max(1, h - 1)
        d.line((0, y, w, y), fill=tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return g


def stars(im, seed, n, area):
    import random
    r = random.Random(seed)
    d = ImageDraw.Draw(im)
    x0, y0, x1, y1 = area
    for _ in range(n):
        x, y = r.randrange(x0, x1), r.randrange(y0, y1)
        c = r.choice([(60, 70, 100), (90, 100, 140), (140, 150, 190)])
        d.rectangle((x, y, x + (r.random() < .2), y + (r.random() < .2)), fill=c)


def text_center(d, cx, y, s, font, fill, shadow=None):
    w = d.textlength(s, font=font)
    if shadow: d.text((cx - w / 2 + 2, y + 2), s, font=font, fill=shadow)
    d.text((cx - w / 2, y), s, font=font, fill=fill)


# columna izquierda de las pantallas de bienvenida / fin del instalador (164x314)
def sidebar(sub):
    w, h = 164, 314
    im = gradient(w, h, BG2, BG)
    stars(im, 7, 70, (0, 0, w, h))
    d = ImageDraw.Draw(im)
    # resplandor dorado detrás del personaje
    glow = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse((22, 34, 142, 154), fill=ACC + (70,))
    im.paste(glow.filter(ImageFilter.GaussianBlur(22)), (0, 0), glow.filter(ImageFilter.GaussianBlur(22)))
    spr = icon(128)
    im.paste(spr, ((w - 128) // 2, 30), spr)
    d = ImageDraw.Draw(im)
    big = ImageFont.truetype(PIXEL_FONT, 16)
    text_center(d, w / 2, 182, 'PIXEL', big, TEXT, shadow=(0, 0, 0))
    text_center(d, w / 2, 204, 'SHOOTER', big, ACC, shadow=(0, 0, 0))
    d.rectangle((52, 232, 112, 233), fill=ACC)
    small = ImageFont.truetype(TEXT_FONT, 11, layout_engine=ImageFont.Layout.BASIC)
    text_center(d, w / 2, 244, sub, small, MUTED)
    text_center(d, w / 2, 292, 'Roguelike · PvP · Co-op', ImageFont.truetype(TEXT_FONT, 10, layout_engine=ImageFont.Layout.BASIC), (90, 100, 130))
    return im


sidebar('Instalador para Windows').save(OUT / 'installerSidebar.bmp')
sidebar('Desinstalador').save(OUT / 'uninstallerSidebar.bmp')

# franja superior de las demás pantallas del instalador (150x57)
hd = Image.new('RGB', (150, 57), (255, 255, 255))
d = ImageDraw.Draw(hd)
spr = icon(44)
hd.paste(spr, (150 - 44 - 8, 6), spr)
f = ImageFont.truetype(PIXEL_FONT, 8)
d.text((8, 18), 'PIXEL', font=f, fill=(30, 34, 48))
d.text((8, 30), 'SHOOTER', font=f, fill=(200, 140, 30))
hd.save(OUT / 'installerHeader.bmp')
print('listo:', ', '.join(p.name for p in sorted(OUT.iterdir())))
