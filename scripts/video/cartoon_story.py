"""Animated cartoon story with Earth Buddy and two kids (1080x1920, 9:16).

Usage: python cartoon_story.py spec.json
Spec:
  ffmpeg, work, out, music, logo, partnerLogo, mascot
  voice, rate, pitch            edge-tts voice settings
  lines   [{say, sub}] six lines, one per scene, in this order:
          title, hot, room, kids, cool, celebrate, cta
          (seven entries: the first is the title)
  title_small, title_big        title card text
  cta_top, cta_button, cta_site closing card text

Scenes: title card, a scorching day (angry sun, heat waves, sweating Earth
Buddy), an empty room with the fan and light on, the kids switching off and
planting a sapling, the sky cooling down, a Children's Day party, and the
closing card. Earth Buddy lip-syncs to the voice; subtitles run underneath.
Pillow draws every frame and pipes it to ffmpeg.
"""
import asyncio, json, math, os, random, subprocess, sys
from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import earth_buddy as eb  # noqa: E402

W, H, FPS = 1080, 1920, 30
GROUND = 1250
SKIN = (233, 180, 130)
INK = (40, 30, 30)
rnd = random.Random(5)


def clamp(t):
    return max(0.0, min(1.0, t))


def lerp(a, b, t):
    return a + (b - a) * t


def mixc(a, b, t):
    return tuple(int(lerp(a[i], b[i], t)) for i in range(3))


def bounce(t):
    """0..1 -> drop-in with a small bounce."""
    t = clamp(t)
    if t < 0.6:
        return eb.ease(t / 0.6)
    return 1 + math.sin((t - 0.6) / 0.4 * math.pi) * 0.08 * (1 - t)


def gradient(top, bot, h=H):
    im = Image.new("RGB", (W, h))
    d = ImageDraw.Draw(im)
    for y in range(h):
        d.line((0, y, W, y), fill=mixc(top, bot, y / h))
    return im.convert("RGBA")


def outlined(d, xy, text, size, fill, stroke=8, anchor="mm", path=None):
    d.text(xy, text, font=eb.font(path or eb.FX, size), fill=fill, anchor=anchor, stroke_width=stroke, stroke_fill=INK)


def burst(frame, cx, cy, r, text, color, p):
    """Comic starburst with text, popping in with progress p."""
    if p <= 0:
        return
    s = eb.pop(p) if p < 1 else 1.0
    rr = r * s
    layer = Image.new("RGBA", (int(rr * 2.6), int(rr * 2.6)), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    c = layer.width / 2
    pts = []
    for k in range(24):
        a = math.pi * 2 * k / 24
        rad = rr if k % 2 == 0 else rr * 0.72
        pts.append((c + math.cos(a) * rad * 1.15, c + math.sin(a) * rad * 0.85))
    d.polygon(pts, fill=color, outline=INK, width=6)
    outlined(d, (c, c), text, int(min(rr * 0.42, rr * 2.2 / (len(text) * 0.56))), (255, 255, 255), stroke=6)
    frame.alpha_composite(layer, (int(cx - c), int(cy - c)))


# ------------------------------------------------------------- Earth Buddy

class Buddy:
    def __init__(self, path, height):
        base = eb.cutout(path)
        box = base.getbbox()
        self.mouth = (448, 568, 664, 642)
        self.sprites = {}
        for mood in ("normal", "hot"):
            src = base
            if mood == "hot":
                red = Image.new("RGBA", base.size, (255, 90, 90, 0))
                red.putalpha(base.getchannel("A").point(lambda v: int(v * 0.16)))
                src = base.copy()
                src.alpha_composite(red)
            for lv in range(6):
                im = eb.open_mouth(src, lv / 5, self.mouth) if lv else src
                im = im.crop(box)
                self.sprites[(mood, lv)] = im.resize((int(im.width * height / im.height), height), Image.LANCZOS)
        self.h = height

    def draw(self, frame, cx, ground, t, level=0.0, mood="normal", scale=1.0, squash=0.0, tilt=0.0, alpha=1.0):
        im = self.sprites[(mood, min(5, int(level * 5 + 0.5)))]
        w, h = int(im.width * scale * (1 + squash)), int(im.height * scale * (1 - squash))
        if w < 2 or h < 2:
            return
        im = im.resize((w, h), Image.BICUBIC)
        if tilt:
            im = im.rotate(tilt, resample=Image.BICUBIC, expand=True)
        if alpha < 1:
            im.putalpha(im.getchannel("A").point(lambda v: int(v * alpha)))
        frame.alpha_composite(im, (int(cx - im.width / 2), int(ground - im.height)))
        return (cx, ground - h)


def sweat(frame, cx, top, t, n=5):
    d = ImageDraw.Draw(frame)
    for k in range(n):
        ph = (t * 1.3 + k / n) % 1.0
        side = -1 if k % 2 else 1
        x = cx + side * (90 + 40 * (k % 3)) + side * ph * 40
        y = top + 60 + ph * 220
        a = int(255 * (1 - ph))
        d.ellipse((x - 11, y - 6, x + 11, y + 22), fill=(120, 200, 255, a), outline=(40, 110, 200, a), width=3)
        d.polygon([(x - 9, y + 2), (x + 9, y + 2), (x, y - 20)], fill=(120, 200, 255, a))


def sparkles(frame, cx, cy, t, spread=260, n=8, color=(255, 236, 140)):
    d = ImageDraw.Draw(frame)
    for k in range(n):
        a = k / n * math.pi * 2 + t * 0.8
        ph = (t * 1.5 + k * 0.37) % 1.0
        r = 14 * math.sin(ph * math.pi)
        x, y = cx + math.cos(a) * spread * (0.7 + 0.3 * ph), cy + math.sin(a) * spread * 0.8 * (0.7 + 0.3 * ph)
        d.polygon([(x, y - r * 2), (x + r * 0.5, y - r * 0.5), (x + r * 2, y), (x + r * 0.5, y + r * 0.5), (x, y + r * 2), (x - r * 0.5, y + r * 0.5), (x - r * 2, y), (x - r * 0.5, y - r * 0.5)], fill=color)


# ------------------------------------------------------------- kids

def kid_sprite(kind, t, arm=0.0, cheer=False, blink=False, carry=False, step=0.0):
    """Draws a kid at 2x then scales down. arm: 0 rest .. 1 raised. Returns RGBA ~ 300x460."""
    S = 2
    w, h = 300 * S, 470 * S
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    cx = w / 2
    o = (60, 40, 40)
    shirt = (37, 99, 235) if kind == "boy" else (236, 72, 153)
    # legs
    for side in (-1, 1):
        lift = step * 18 * S * (1 if side > 0 else -1)
        x = cx + side * 30 * S
        d.rounded_rectangle((x - 17 * S, 340 * S - max(0, lift), x + 17 * S, 440 * S - max(0, lift)), 14 * S, fill=(55, 65, 81) if kind == "boy" else SKIN, outline=o, width=3 * S)
        d.ellipse((x - 30 * S, 425 * S - max(0, lift), x + 26 * S, 462 * S - max(0, lift)), fill=(239, 68, 68) if kind == "boy" else (250, 204, 21), outline=o, width=3 * S)
    # body
    if kind == "boy":
        d.rounded_rectangle((cx - 72 * S, 215 * S, cx + 72 * S, 355 * S), 34 * S, fill=shirt, outline=o, width=4 * S)
        d.ellipse((cx - 22 * S, 255 * S, cx + 22 * S, 299 * S), fill=(74, 222, 128), outline=o, width=3 * S)  # leaf badge
    else:
        d.polygon([(cx - 55 * S, 215 * S), (cx + 55 * S, 215 * S), (cx + 100 * S, 360 * S), (cx - 100 * S, 360 * S)], fill=shirt, outline=o, width=4 * S)
        d.line((cx - 80 * S, 330 * S, cx + 80 * S, 330 * S), fill=(255, 255, 255), width=6 * S)
    # arms
    for side in (-1, 1):
        sx, sy = cx + side * 66 * S, 240 * S
        a_up = arm if side > 0 else (arm if cheer else 0.0)
        ang = math.radians(lerp(100, -60, a_up))
        ex = sx + side * math.cos(ang) * 110 * S * (0.55 if not a_up else 1)
        ey = sy + math.sin(ang) * 110 * S
        if carry:
            ex, ey = cx + side * 40 * S, 300 * S
        d.line((sx, sy, ex, ey), fill=shirt if kind == "boy" else SKIN, width=28 * S)
        d.ellipse((ex - 19 * S, ey - 19 * S, ex + 19 * S, ey + 19 * S), fill=SKIN, outline=o, width=3 * S)
    # head
    hy, r = 125 * S, 98 * S
    if kind == "girl":  # pigtails behind head
        for side in (-1, 1):
            d.ellipse((cx + side * 105 * S - 38 * S, hy - 10 * S, cx + side * 105 * S + 38 * S, hy + 70 * S), fill=(40, 25, 20))
    d.ellipse((cx - r, hy - r, cx + r, hy + r), fill=SKIN, outline=o, width=4 * S)
    # hair
    if kind == "boy":
        d.chord((cx - r - 4 * S, hy - r - 6 * S, cx + r + 4 * S, hy + r * 0.6), 180, 360, fill=(30, 22, 18))
        for k in range(5):
            x = cx - 60 * S + k * 30 * S
            d.polygon([(x - 18 * S, hy - r + 20 * S), (x + 18 * S, hy - r + 20 * S), (x + 6 * S, hy - r - 26 * S)], fill=(30, 22, 18))
    else:
        d.chord((cx - r - 6 * S, hy - r - 8 * S, cx + r + 6 * S, hy + r * 0.5), 180, 360, fill=(40, 25, 20))
        bx = cx + 62 * S
        d.polygon([(bx, hy - 80 * S), (bx - 40 * S, hy - 110 * S), (bx - 40 * S, hy - 50 * S)], fill=(250, 204, 21), outline=o)
        d.polygon([(bx, hy - 80 * S), (bx + 40 * S, hy - 110 * S), (bx + 40 * S, hy - 50 * S)], fill=(250, 204, 21), outline=o)
    # face
    for side in (-1, 1):
        ex, ey = cx + side * 36 * S, hy + 10 * S
        if blink:
            d.line((ex - 14 * S, ey, ex + 14 * S, ey), fill=o, width=4 * S)
        else:
            d.ellipse((ex - 16 * S, ey - 20 * S, ex + 16 * S, ey + 20 * S), fill=(255, 255, 255), outline=o, width=3 * S)
            d.ellipse((ex - 9 * S, ey - 8 * S, ex + 9 * S, ey + 14 * S), fill=(30, 20, 20))
            d.ellipse((ex - 3 * S, ey - 4 * S, ex + 3 * S, ey + 2 * S), fill=(255, 255, 255))
        d.ellipse((cx + side * 62 * S - 16 * S, hy + 42 * S, cx + side * 62 * S + 16 * S, hy + 58 * S), fill=(248, 150, 160))
    if cheer:
        d.chord((cx - 34 * S, hy + 34 * S, cx + 34 * S, hy + 90 * S), 0, 180, fill=(150, 30, 40), outline=o, width=3 * S)
    else:
        d.arc((cx - 30 * S, hy + 24 * S, cx + 30 * S, hy + 66 * S), 20, 160, fill=o, width=5 * S)
    return im.resize((w // S, h // S), Image.LANCZOS)


def draw_kid(frame, kind, cx, ground, t, scale=1.0, **kw):
    blink = (t * 0.7 + (0.3 if kind == "girl" else 0)) % 3.2 < 0.12
    im = kid_sprite(kind, t, blink=blink, **kw)
    if scale != 1.0:
        im = im.resize((int(im.width * scale), int(im.height * scale)), Image.BICUBIC)
    frame.alpha_composite(im, (int(cx - im.width / 2), int(ground - im.height)))


# ------------------------------------------------------------- props

def sun(d, cx, cy, r, t, angry=0.0, rays_spin=0.6):
    ray_col = mixc((253, 224, 71), (249, 115, 22), angry)
    for k in range(14):
        a = t * rays_spin + k * math.pi * 2 / 14
        r1, r2 = r * 1.12, r * (1.45 + 0.08 * math.sin(t * 6 + k))
        w = 0.12
        d.polygon([(cx + math.cos(a - w) * r1, cy + math.sin(a - w) * r1), (cx + math.cos(a) * r2, cy + math.sin(a) * r2), (cx + math.cos(a + w) * r1, cy + math.sin(a + w) * r1)], fill=ray_col)
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=mixc((253, 230, 90), (251, 146, 60), angry), outline=INK, width=6)
    # face
    for side in (-1, 1):
        ex, ey = cx + side * r * 0.35, cy - r * 0.1
        d.ellipse((ex - r * 0.1, ey - r * 0.12, ex + r * 0.1, ey + r * 0.12), fill=INK)
        if angry > 0.3:  # brows
            d.line((ex - side * r * 0.2, ey - r * 0.3, ex + side * r * 0.05, ey - r * 0.18), fill=INK, width=8)
    if angry > 0.3:
        d.arc((cx - r * 0.4, cy + r * 0.15, cx + r * 0.4, cy + r * 0.55), 200, 340, fill=INK, width=8)
        d.chord((cx - r * 0.35, cy + r * 0.2, cx + r * 0.35, cy + r * 0.6), 0, 180, fill=(150, 30, 40), outline=INK, width=5)
    else:
        d.arc((cx - r * 0.4, cy - r * 0.05, cx + r * 0.4, cy + r * 0.5), 20, 160, fill=INK, width=8)
        for side in (-1, 1):
            d.ellipse((cx + side * r * 0.6 - 18, cy + r * 0.2 - 10, cx + side * r * 0.6 + 18, cy + r * 0.2 + 10), fill=(248, 150, 160))


def cloud(d, x, y, s, col=(255, 255, 255)):
    for dx, dy, r in ((0, 0, 60), (60, -30, 70), (125, 0, 58), (60, 15, 60)):
        d.ellipse((x + dx * s - r * s, y + dy * s - r * s, x + dx * s + r * s, y + dy * s + r * s), fill=col)


def heat_waves(d, t, col=(255, 255, 255, 90)):
    for k in range(7):
        x0 = 80 + k * 150
        pts = []
        for j in range(30):
            y = GROUND - 40 - j * 22 - (t * 120 % 66)
            pts.append((x0 + math.sin(j * 0.6 + t * 4 + k) * 18, y))
        d.line(pts, fill=col, width=6)


def thermometer(d, x, y, level):
    d.rounded_rectangle((x - 26, y, x + 26, y + 420), 26, fill=(255, 255, 255), outline=INK, width=6)
    d.ellipse((x - 46, y + 380, x + 46, y + 472), fill=(239, 68, 68), outline=INK, width=6)
    top = y + 400 - 370 * level
    d.rounded_rectangle((x - 13, top, x + 13, y + 410), 13, fill=(239, 68, 68))
    for k in range(6):
        d.line((x + 26, y + 60 + k * 60, x + 44, y + 60 + k * 60), fill=INK, width=4)


def fan(frame, cx, cy, angle, alpha_blur=False):
    d = ImageDraw.Draw(frame)
    d.line((cx, 0, cx, cy), fill=(80, 80, 90), width=10)
    for k in range(3):
        a = angle + k * math.pi * 2 / 3
        pts = []
        for s, wv in ((0.15, 0.25), (1.0, 0.12), (1.0, -0.12), (0.15, -0.25)):
            pts.append((cx + math.cos(a + wv) * 230 * s, cy + math.sin(a + wv) * 50 * s))
        d.polygon(pts, fill=(229, 231, 235), outline=INK, width=4)
    d.ellipse((cx - 36, cy - 26, cx + 36, cy + 26), fill=(156, 163, 175), outline=INK, width=5)


def bulb(frame, cx, cy, on, t):
    d = ImageDraw.Draw(frame)
    d.line((cx, 0, cx, cy - 50), fill=(60, 60, 60), width=6)
    if on > 0:
        g = Image.new("RGBA", (500, 500), (0, 0, 0, 0))
        ImageDraw.Draw(g).ellipse((80, 80, 420, 420), fill=(255, 240, 150, int(150 * on)))
        g = g.filter(ImageFilter.GaussianBlur(50))
        frame.alpha_composite(g, (int(cx - 250), int(cy - 250)))
        for k in range(10):
            a = k * math.pi * 2 / 10 + t
            r1, r2 = 80, 115 + 10 * math.sin(t * 8 + k)
            d.line((cx + math.cos(a) * r1, cy + math.sin(a) * r1, cx + math.cos(a) * r2, cy + math.sin(a) * r2), fill=(250, 204, 21, int(255 * on)), width=7)
    d.rectangle((cx - 22, cy - 60, cx + 22, cy - 30), fill=(120, 120, 130), outline=INK, width=4)
    d.ellipse((cx - 50, cy - 45, cx + 50, cy + 55), fill=mixc((209, 213, 219), (254, 240, 138), on), outline=INK, width=5)


def switch(d, x, y, on, glow=0.0):
    d.rounded_rectangle((x - 70, y - 100, x + 70, y + 100), 20, fill=(255, 255, 255), outline=INK, width=6)
    d.rounded_rectangle((x - 30, y - 60, x + 30, y + 60), 12, fill=(229, 231, 235), outline=INK, width=4)
    ky = y - 30 if on else y + 30
    d.rounded_rectangle((x - 26, ky - 26, x + 26, ky + 26), 10, fill=(239, 68, 68) if on else (34, 197, 94), outline=INK, width=4)


def plant(d, x, ground, grow, t):
    # pot
    d.polygon([(x - 80, ground - 120), (x + 80, ground - 120), (x + 60, ground), (x - 60, ground)], fill=(194, 94, 50), outline=INK, width=6)
    d.rectangle((x - 90, ground - 140, x + 90, ground - 115), fill=(214, 110, 60), outline=INK, width=6)
    if grow <= 0:
        return
    top = ground - 140 - 300 * eb.ease(grow)
    sway = math.sin(t * 2) * 10 * grow
    d.line((x, ground - 140, x + sway, top), fill=(22, 101, 52), width=14)
    for k, (fy, side) in enumerate(((0.35, -1), (0.55, 1), (0.75, -1), (0.9, 1))):
        lg = clamp((grow - 0.15 * k) / 0.35)
        if lg <= 0:
            continue
        ly = lerp(ground - 140, top, fy)
        lx = x + sway * fy
        L = 90 * eb.ease(lg)
        d.ellipse((lx + (0 if side > 0 else -L), ly - L * 0.35, lx + (L if side > 0 else 0), ly + L * 0.35), fill=(74, 222, 128), outline=INK, width=4)
    fl = clamp((grow - 0.75) / 0.25)
    if fl > 0:
        fx, fy = x + sway, top
        for k in range(6):
            a = k * math.pi / 3 + t
            px, py = fx + math.cos(a) * 34 * fl, fy + math.sin(a) * 34 * fl
            d.ellipse((px - 24 * fl, py - 24 * fl, px + 24 * fl, py + 24 * fl), fill=(244, 114, 182), outline=INK, width=3)
        d.ellipse((fx - 20 * fl, fy - 20 * fl, fx + 20 * fl, fy + 20 * fl), fill=(250, 204, 21), outline=INK, width=3)


def hills(d, col1, col2):
    d.ellipse((-300, GROUND - 260, 700, GROUND + 400), fill=col1)
    d.ellipse((400, GROUND - 200, 1500, GROUND + 400), fill=col2)
    d.rectangle((0, GROUND, W, H), fill=col2)


# ------------------------------------------------------------- scenes

def scene_title(f, lt, D, t, buddy, lv, sp):
    d = ImageDraw.Draw(f)
    sun(d, 930, 420 - 160 * eb.ease(lt / 1.2), 95, t, angry=0.0)
    cloud(d, 90 + lt * 30, 380, 1.0)
    hills(d, (134, 239, 172), (74, 222, 128))
    words = sp["title_small"]
    outlined(d, (W / 2, 330), words, 78, (255, 255, 255), stroke=8)
    big = sp["title_big"].split()
    for i, wd in enumerate(big):
        p = (lt - 0.3 - i * 0.25) / 0.45
        if p <= 0:
            continue
        y = 460 + i * 140 - (1 - bounce(p)) * 400
        outlined(d, (W / 2, y), wd, 132, (253, 224, 71) if i % 2 == 0 else (251, 146, 60), stroke=10)
    jp = (lt - 0.8) / 0.6
    if jp > 0:
        hop = abs(math.sin(lt * 3.2)) * 40
        sq = 0.08 * math.cos(lt * 6.4)
        buddy.draw(f, W / 2, GROUND + 80 - hop + (1 - bounce(jp)) * 500, t, lv, squash=sq, scale=0.85)


def scene_hot(f, lt, D, t, buddy, lv, sp):
    d = ImageDraw.Draw(f, "RGBA")
    sun(d, 800, 360, 150 + 10 * math.sin(t * 5), t, angry=1.0, rays_spin=1.5)
    hills(d, (217, 119, 6), (180, 83, 9))
    for k in range(6):  # cracks
        x = 120 + k * 170
        d.line((x, GROUND + 60, x + 40, GROUND + 120, x + 10, GROUND + 180), fill=(120, 53, 15), width=6)
    heat_waves(d, t)
    thermometer(d, 140, 520, clamp(0.3 + lt / D * 0.75))
    wob = math.sin(t * 7) * 5
    buddy.draw(f, W / 2 + 40, GROUND + 40, t, lv, mood="hot", tilt=wob, squash=0.05 * math.sin(t * 4))
    sweat(f, W / 2 + 40, GROUND + 40 - buddy.h, t)
    burst(f, 300, 1000 - 0, 120, "UFF!", (239, 68, 68), (lt - 0.6) / 0.4)


def room_bg(f, dark=0.0):
    d = ImageDraw.Draw(f)
    d.rectangle((0, 0, W, GROUND), fill=mixc((254, 243, 199), (120, 110, 90), dark))
    for k in range(0, W, 90):  # wallpaper stripes
        d.line((k, 0, k, GROUND), fill=mixc((253, 230, 170), (110, 100, 80), dark), width=20)
    d.rectangle((0, GROUND, W, H), fill=mixc((180, 120, 70), (90, 60, 35), dark))
    for k in range(GROUND, H, 60):
        d.line((0, k, W, k), fill=mixc((150, 95, 55), (70, 45, 25), dark), width=4)
    # window with the hot sun outside
    d.rounded_rectangle((640, 420, 980, 760), 20, fill=(253, 186, 116), outline=INK, width=8)
    d.ellipse((800, 470, 920, 590), fill=(251, 146, 60))
    d.line((810, 420, 810, 760), fill=INK, width=8)
    d.line((640, 590, 980, 590), fill=INK, width=8)
    # empty chair and table
    d.rectangle((180, 1020, 420, 1050), fill=(146, 64, 14), outline=INK, width=5)
    d.rectangle((195, 1050, 215, GROUND), fill=(146, 64, 14))
    d.rectangle((385, 1050, 405, GROUND), fill=(146, 64, 14))
    d.rounded_rectangle((460, 960, 560, 1100), 10, fill=(37, 99, 235), outline=INK, width=5)
    d.rectangle((470, 1100, 485, GROUND), fill=(37, 99, 235))
    d.rectangle((535, 1100, 550, GROUND), fill=(37, 99, 235))


def scene_room(f, lt, D, t, buddy, lv, sp):
    room_bg(f)
    fan(f, W / 2, 300, t * 9)
    bulb(f, 250, 560, 1.0, t)
    d = ImageDraw.Draw(f)
    switch(d, 110, 860, True)
    peek = eb.ease(lt / 0.6)
    shake = math.sin(t * 40) * 6 if lt > 0.6 else 0
    buddy.draw(f, W + 120 - 380 * peek + shake, GROUND + 60, t, lv, mood="hot", scale=0.9)
    burst(f, W / 2, 500, 110, "PANKHA ON!", (59, 130, 246), (lt - 0.7) / 0.4)
    burst(f, 330, 860, 100, "LIGHT ON!", (234, 179, 8), (lt - 1.4) / 0.4)
    q = (lt - 1.9) / 0.3
    if q > 0:
        outlined(d, (W - 180, 760 - 20 * math.sin(t * 6)), "?!", 120, (239, 68, 68), stroke=8)


def scene_kids(f, lt, D, t, buddy, lv, sp):
    click = D * 0.32
    off = clamp((lt - click) / 0.6)
    room_bg(f, dark=0.0)
    speed = 9 * (1 - off) ** 2
    fan(f, W / 2, 300, 9 * min(lt, click) + (speed * 0.4) * max(0, lt - click))
    bulb(f, 250, 560, 1 - off, t)
    d = ImageDraw.Draw(f)
    switch(d, 110, 860, lt < click)
    # Chhotu runs to the switch
    run = eb.ease(lt / (click * 0.8))
    kx = lerp(-200, 250, run)
    step = math.sin(t * 16) if run < 1 else 0
    draw_kid(f, "boy", kx, GROUND + 70 - abs(step) * 20, t, arm=1.0 if click - 0.3 < lt < click + 0.5 else 0.2, cheer=lt > click + 0.5, step=step)
    burst(f, 230, 700, 110, "CLICK!", (34, 197, 94), (lt - click) / 0.3)
    # Pinky brings a sapling
    pk = D * 0.5
    pr = eb.ease((lt - pk * 0.6) / (pk * 0.5))
    px = lerp(W + 200, 760, pr)
    planted = lt > pk + 0.3
    if planted:
        plant(d, 640, GROUND + 60, clamp((lt - pk - 0.3) / 1.4), t)
    draw_kid(f, "girl", px + (120 if planted else 0), GROUND + 70, t, carry=not planted, cheer=planted, arm=1.0 if planted else 0)
    if not planted:
        plant(ImageDraw.Draw(f), px, GROUND - 90, 0.12, t)
    buddy.draw(f, 810, 770, t, lv, mood="hot" if off < 1 else "normal", scale=0.42)


def scene_cool(f, lt, D, t, buddy, lv, sp):
    k = clamp(lt / 1.2)
    bg = gradient(mixc((251, 146, 60), (125, 211, 252), k), mixc((254, 215, 170), (224, 242, 254), k), GROUND + 50)
    f.alpha_composite(bg)
    d = ImageDraw.Draw(f)
    sun(d, 820, 330, lerp(150, 100, k), t, angry=1 - k, rays_spin=0.5)
    for i in range(3):
        cloud(d, (-300 + i * 420 + lt * 90) % (W + 400) - 200, 420 + i * 110, 1.1)
    hills(d, mixc((217, 119, 6), (134, 239, 172), k), mixc((180, 83, 9), (74, 222, 128), k))
    for x in (130, 950):  # trees pop up
        tg = eb.ease((lt - 0.6) / 0.6)
        if tg > 0:
            d.rectangle((x - 15, GROUND - 160 * tg, x + 15, GROUND), fill=(120, 53, 15))
            d.ellipse((x - 90 * tg, GROUND - 330 * tg, x + 90 * tg, GROUND - 140 * tg), fill=(22, 163, 74), outline=INK, width=5)
    hop = abs(math.sin(lt * 4)) * 70
    buddy.draw(f, W / 2, GROUND + 60 - hop, t, lv, squash=0.07 * math.cos(lt * 8))
    sparkles(f, W / 2, GROUND - 250 - hop, t, n=10, color=(255, 255, 255))
    burst(f, W / 2, 640, 135, "COOL COOL!", (14, 165, 233), (lt - 1.0) / 0.4)


CONF = [(rnd.uniform(0, W), rnd.uniform(-H, 0), rnd.uniform(200, 380), rnd.choice([(239, 68, 68), (250, 204, 21), (34, 197, 94), (59, 130, 246), (236, 72, 153), (168, 85, 247)]), rnd.uniform(0, 6.28)) for _ in range(90)]
BALL = [(rnd.uniform(60, W - 60), rnd.uniform(0, 1.5), rnd.choice([(239, 68, 68), (250, 204, 21), (59, 130, 246), (236, 72, 153), (34, 197, 94)])) for _ in range(9)]


def scene_party(f, lt, D, t, buddy, lv, sp):
    f.alpha_composite(gradient((129, 140, 248), (196, 181, 253), GROUND + 50))
    d = ImageDraw.Draw(f)
    d.rectangle((0, GROUND, W, H), fill=(74, 222, 128))
    # bunting
    for row, y0 in enumerate((180, 300)):
        for k in range(10):
            x = k * 120 + (60 if row else 0)
            yy = y0 + 30 * math.sin(k / 9 * math.pi) + 6 * math.sin(t * 3 + k)
            col = [(239, 68, 68), (250, 204, 21), (34, 197, 94), (59, 130, 246)][(k + row) % 4]
            d.polygon([(x, yy), (x + 110, yy), (x + 55, yy + 90)], fill=col, outline=INK, width=3)
    for x, delay, col in BALL:
        y = H + 100 - ((lt + delay) * 260) % (H + 300)
        d.line((x, y + 80, x + 10 * math.sin(t * 3 + x), y + 220), fill=(80, 80, 80), width=3)
        d.ellipse((x - 55, y - 70, x + 55, y + 80), fill=col, outline=INK, width=4)
        d.ellipse((x - 30, y - 45, x - 12, y - 15), fill=(255, 255, 255, 180))
    p = (lt - 0.2) / 0.5
    if p > 0:
        s = eb.pop(p) if p < 1 else 1
        outlined(d, (W / 2, 560), "HAPPY", int(150 * s), (253, 224, 71), stroke=10)
        outlined(d, (W / 2, 720), "CHILDREN'S DAY!", int(110 * s), (255, 255, 255), stroke=10)
    for k, kind in enumerate(("boy", "girl")):
        hop = abs(math.sin(lt * 5 + k * 1.5)) * 60
        draw_kid(f, kind, 230 if k == 0 else W - 230, GROUND + 80 - hop, t, cheer=True, arm=0.5 + 0.5 * math.sin(t * 8 + k))
    hop = abs(math.sin(lt * 4.5 + 0.7)) * 60
    buddy.draw(f, W / 2, GROUND + 70 - hop, t, lv, scale=0.85)
    for x, y0, sp_, col, ph in CONF:
        y = (y0 + sp_ * lt) % (H + 100)
        x2 = x + math.sin(t * 2 + ph) * 30
        a = t * 5 + ph
        d.polygon([(x2 + math.cos(a) * 14, y + math.sin(a) * 6), (x2 - math.sin(a) * 6, y + math.cos(a) * 14), (x2 - math.cos(a) * 14, y - math.sin(a) * 6), (x2 + math.sin(a) * 6, y - math.cos(a) * 14)], fill=col)


def scene_cta(f, lt, D, t, buddy, lv, sp, card):
    f.alpha_composite(gradient((22, 101, 52), (21, 128, 61)))
    d = ImageDraw.Draw(f)
    p = (lt - 0.1) / 0.5
    if p > 0:
        s = eb.pop(p) if p < 1 else 1
        c = card.resize((int(card.width * s), int(card.height * s)), Image.BICUBIC)
        f.alpha_composite(c, (int(W / 2 - c.width / 2), int(330 - c.height / 2 + 60)))
    q = (lt - 0.5) / 0.4
    if q > 0:
        fnt, tl = eb.fit_lines(d, sp["cta_top"], eb.FX, 78, W - 160, 2)
        for i, ln in enumerate(tl):
            outlined(d, (W / 2, 600 + i * (fnt.size + 14) - (len(tl) - 1) * (fnt.size + 14) / 2), ln, fnt.size, (253, 224, 71), stroke=7)
        by = 800 - abs(math.sin(t * 5)) * 30
        if sp.get("cta_icon") == "coin":  # a bouncing, spinning KarmaCoin
            cw = 95 * abs(math.cos(t * 3)) + 12
            d.ellipse((W / 2 - cw, by - 95, W / 2 + cw, by + 95), fill=(250, 204, 21), outline=INK, width=6)
            if cw > 50:
                outlined(d, (W / 2, by), "K", int(110 * cw / 107), (161, 98, 7), stroke=4)
        else:  # upvote arrow bouncing
            d.polygon([(W / 2, by - 90), (W / 2 + 90, by + 20), (W / 2 - 90, by + 20)], fill=(255, 255, 255), outline=INK, width=6)
        bw = 760
        d.rounded_rectangle((W / 2 - bw / 2, 870, W / 2 + bw / 2, 990), 60, fill=(251, 146, 60), outline=INK, width=6)
        bf = 56
        while bf > 30 and d.textlength(sp["cta_button"], font=eb.font(eb.FX, bf)) > bw - 70:
            bf -= 2
        outlined(d, (W / 2, 930), sp["cta_button"], bf, (255, 255, 255), stroke=5)
        d.text((W / 2, 1040), sp["cta_site"], font=eb.font(eb.FB, 44), fill=(220, 252, 231), anchor="mm")
    hop = abs(math.sin(lt * 3.5)) * 40
    buddy.draw(f, W / 2, 1375 - hop, t, lv, scale=0.6)
    sparkles(f, W / 2, 930, t, spread=420, n=10)


# ------------------------------------------------------------- plastic story

def _item_sprites():
    S = {}
    im = Image.new("RGBA", (70, 150), (0, 0, 0, 0)); d = ImageDraw.Draw(im)  # bottle
    d.rounded_rectangle((8, 35, 62, 146), 18, fill=(186, 230, 253, 235), outline=INK, width=4)
    d.rectangle((22, 12, 48, 38), fill=(186, 230, 253, 235), outline=INK, width=4)
    d.rectangle((18, 2, 52, 16), fill=(37, 99, 235), outline=INK, width=4)
    d.rectangle((10, 70, 60, 100), fill=(239, 68, 68))
    S["bottle"] = (im, "dry")
    im = Image.new("RGBA", (130, 120), (0, 0, 0, 0)); d = ImageDraw.Draw(im)  # bag
    d.polygon([(15, 30), (40, 10), (55, 30), (75, 30), (90, 10), (115, 30), (122, 112), (8, 112)], fill=(243, 244, 246), outline=INK, width=4)
    d.line((30, 60, 100, 70), fill=(203, 213, 225), width=4)
    S["bag"] = (im, "dry")
    im = Image.new("RGBA", (80, 120), (0, 0, 0, 0)); d = ImageDraw.Draw(im)  # can
    d.rounded_rectangle((6, 6, 74, 114), 14, fill=(220, 38, 38), outline=INK, width=4)
    d.rectangle((6, 45, 74, 70), fill=(255, 255, 255))
    S["can"] = (im, "dry")
    im = Image.new("RGBA", (140, 90), (0, 0, 0, 0)); d = ImageDraw.Draw(im)  # banana peel
    d.chord((5, -60, 135, 85), 20, 160, fill=(250, 204, 21), outline=INK, width=4)
    d.polygon([(70, 40), (40, 85), (55, 88), (70, 55), (85, 88), (100, 85)], fill=(234, 179, 8), outline=INK)
    S["peel"] = (im, "wet")
    im = Image.new("RGBA", (110, 110), (0, 0, 0, 0)); d = ImageDraw.Draw(im)  # apple core
    d.ellipse((20, 5, 90, 40), fill=(239, 68, 68), outline=INK, width=4)
    d.rectangle((40, 35, 70, 75), fill=(254, 243, 199), outline=INK, width=4)
    d.ellipse((20, 70, 90, 105), fill=(239, 68, 68), outline=INK, width=4)
    S["core"] = (im, "wet")
    return S


ITEMS = None
LITTER = [("bottle", 170, -14), ("bag", 330, 8), ("peel", 470, 0), ("can", 610, 20), ("bottle", 760, -25), ("core", 900, 6),
          ("bag", 250, 35), ("peel", 820, 30), ("can", 400, 40), ("bottle", 540, 35)]
BIN_X = {"dry": 400, "wet": 690}


def items():
    global ITEMS
    if ITEMS is None:
        ITEMS = _item_sprites()
    return ITEMS


def park(f, k, t):
    f.alpha_composite(gradient(mixc((203, 213, 225), (125, 211, 252), k), mixc((241, 245, 249), (224, 242, 254), k), GROUND + 50))
    d = ImageDraw.Draw(f)
    if k > 0.3:
        sun(d, 900, 300, 85, t, angry=0.0)
    for i in range(2):
        cloud(d, (100 + i * 520 + t * 25) % (W + 300) - 150, 330 + i * 120, 1.0, col=mixc((156, 163, 175), (255, 255, 255), k))
    hills(d, mixc((163, 163, 120), (134, 239, 172), k), mixc((132, 140, 90), (74, 222, 128), k))
    for x in (110, 970):
        d.rectangle((x - 16, GROUND - 170, x + 16, GROUND + 10), fill=(120, 53, 15))
        d.ellipse((x - 95, GROUND - 350, x + 95, GROUND - 150), fill=mixc((101, 112, 60), (22, 163, 74), k), outline=INK, width=5)
    return d


def draw_item(f, kind, x, y, rot=0.0, scale=1.05):
    im = items()[kind][0]
    if scale != 1:
        im = im.resize((int(im.width * scale), int(im.height * scale)), Image.BICUBIC)
    if rot:
        im = im.rotate(rot, resample=Image.BICUBIC, expand=True)
    f.alpha_composite(im, (int(x - im.width / 2), int(y - im.height / 2)))


def bin_(d, x, kind, bump=0.0):
    col = (37, 99, 235) if kind == "dry" else (22, 163, 74)
    top = GROUND - 250 - bump * 25
    d.polygon([(x - 115, top), (x + 115, top), (x + 95, GROUND + 60), (x - 95, GROUND + 60)], fill=col, outline=INK, width=6)
    d.rounded_rectangle((x - 130, top - 40, x + 130, top + 5), 14, fill=mixc(col, (255, 255, 255), 0.25), outline=INK, width=6)
    outlined(d, (x, top + 110), "SOOKHA" if kind == "dry" else "GEELA", 46, (255, 255, 255), stroke=5)
    outlined(d, (x, top + 170), "DRY" if kind == "dry" else "WET", 34, (255, 255, 255), stroke=4)


def recycle_symbol(d, cx, cy, r, ang, col=(34, 197, 94)):
    for k in range(3):
        a0 = ang + k * 120
        d.arc((cx - r, cy - r, cx + r, cy + r), a0, a0 + 85, fill=col, width=int(r * 0.28))
        e = math.radians(a0 + 85)
        ex, ey = cx + math.cos(e) * r, cy + math.sin(e) * r
        tx, ty = -math.sin(e), math.cos(e)
        nx, ny = math.cos(e), math.sin(e)
        L, Wd = r * 0.42, r * 0.32
        d.polygon([(ex + tx * L, ey + ty * L), (ex + nx * Wd, ey + ny * Wd), (ex - nx * Wd, ey - ny * Wd)], fill=col)


def scene_litter(f, lt, D, t, buddy, lv, sp):
    park(f, 0.0, t)
    for i, (kind, x, dy) in enumerate(LITTER):
        p = clamp((lt - 0.2 - i * 0.22) / 0.55)
        if p <= 0:
            continue
        y = lerp(-150, GROUND + 50 + dy, eb.ease(p))
        draw_item(f, kind, x, y, rot=(1 - p) * 360 * (1 if i % 2 else -1) + dy)
    wob = math.sin(t * 6) * 4
    buddy.draw(f, W / 2, GROUND + 20, t, lv, mood="hot", tilt=wob, scale=0.85)
    burst(f, 260, 760, 115, "CHHI!", (168, 85, 247), (lt - 2.0) / 0.4)
    if lt > 2.6:
        outlined(ImageDraw.Draw(f), (W - 200, 800 - 20 * math.sin(t * 6)), "?!", 120, (239, 68, 68), stroke=8)


def scene_sort(f, lt, D, t, buddy, lv, sp):
    park(f, 0.0, t)
    order = sorted(range(len(LITTER)), key=lambda i: LITTER[i][1])
    step = max(0.3, (D - 1.6) / len(LITTER))
    flights = [(i, 0.8 + n * step) for n, i in enumerate(order)]
    bump = {"dry": 0.0, "wet": 0.0}
    for i, st in flights:
        kind, x, dy = LITTER[i]
        side = items()[kind][1]
        p = (lt - st) / 0.6
        if p < 0:
            draw_item(f, kind, x, GROUND + 50 + dy, rot=dy)
        elif p < 1:
            bx = BIN_X[side]
            xx = lerp(x, bx, p)
            yy = lerp(GROUND + 50 + dy, GROUND - 300, p) - math.sin(p * math.pi) * 380
            draw_item(f, kind, xx, yy, rot=p * 540)
        elif p < 1.5:
            bump[side] = max(bump[side], math.sin((p - 1) / 0.5 * math.pi))
    d = ImageDraw.Draw(f)
    bin_(d, BIN_X["dry"], "dry", bump["dry"])
    bin_(d, BIN_X["wet"], "wet", bump["wet"])

    def throw(ph):
        return 1.0 if (t * 2 + ph) % 1.0 < 0.4 else 0.2
    draw_kid(f, "boy", 150, GROUND + 80 - abs(math.sin(t * 4)) * 15, t, arm=throw(0), cheer=True)
    draw_kid(f, "girl", 935, GROUND + 80 - abs(math.sin(t * 4 + 1)) * 15, t, arm=throw(0.5), cheer=True)
    buddy.draw(f, W / 2 + 10, GROUND - 330, t, lv, mood="hot", scale=0.42)


def scene_recycle(f, lt, D, t, buddy, lv, sp):
    k = clamp((lt - 1.6) / 1.4)
    d = park(f, k, t)
    for i in range(9):  # flowers pop up as the park turns green
        fp = eb.ease((lt - 2.2 - i * 0.12) / 0.4)
        if fp <= 0:
            continue
        x = 70 + i * 118
        y = GROUND + 120 + (i % 2) * 70
        d.line((x, y, x, y - 70 * fp), fill=(22, 101, 52), width=8)
        col = [(244, 114, 182), (250, 204, 21), (248, 113, 113), (192, 132, 252)][i % 4]
        for j in range(5):
            a = j * 1.2566 + t
            px, py = x + math.cos(a) * 22 * fp, y - 70 * fp + math.sin(a) * 22 * fp
            d.ellipse((px - 16 * fp, py - 16 * fp, px + 16 * fp, py + 16 * fp), fill=col, outline=INK, width=2)
        d.ellipse((x - 12 * fp, y - 70 * fp - 12 * fp, x + 12 * fp, y - 70 * fp + 12 * fp), fill=(250, 204, 21))
    sp_ = eb.pop(clamp(lt / 0.6)) if lt < 0.6 else 1.0
    recycle_symbol(d, W / 2, 720, 210 * sp_, t * 140)
    sparkles(f, W / 2, 720, t, spread=300, n=10)
    burst(f, W / 2, 1020, 120, "RECYCLE!", (34, 197, 94), (lt - 0.5) / 0.4)
    buddy.draw(f, W - 190, GROUND + 60 - abs(math.sin(lt * 4)) * 30 * k, t, lv, mood="hot" if k < 0.6 else "normal", scale=0.7)


LEAVES = [(rnd.uniform(0, W), rnd.uniform(-H, 0), rnd.uniform(150, 280), rnd.uniform(0, 6.28)) for _ in range(40)]


def scene_happy(f, lt, D, t, buddy, lv, sp):
    d = park(f, 1.0, t)
    for i in range(9):
        x = 70 + i * 118
        y = GROUND + 120 + (i % 2) * 70
        d.line((x, y, x, y - 70), fill=(22, 101, 52), width=8)
        d.ellipse((x - 26, y - 96, x + 26, y - 44), fill=[(244, 114, 182), (250, 204, 21), (248, 113, 113), (192, 132, 252)][i % 4], outline=INK, width=3)
    p = (lt - 0.2) / 0.5
    if p > 0:
        s = eb.pop(p) if p < 1 else 1
        outlined(d, (W / 2, 560), sp.get("happy_1", "KACHRA ALAG,"), int(104 * s), (255, 255, 255), stroke=10)
        outlined(d, (W / 2, 700), sp.get("happy_2", "DHARTI KHUSH!"), int(112 * s), (253, 224, 71), stroke=10)
    for k, kind in enumerate(("boy", "girl")):
        hop = abs(math.sin(lt * 5 + k * 1.5)) * 60
        draw_kid(f, kind, 220 if k == 0 else W - 220, GROUND + 80 - hop, t, cheer=True, arm=0.5 + 0.5 * math.sin(t * 8 + k))
    hop = abs(math.sin(lt * 4.5 + 0.7)) * 60
    buddy.draw(f, W / 2, GROUND + 70 - hop, t, lv, scale=0.85)
    for x, y0, spd, ph in LEAVES:
        y = (y0 + spd * lt) % (H + 100)
        x2 = x + math.sin(t * 2 + ph) * 40
        d.ellipse((x2 - 18, y - 9, x2 + 18, y + 9), fill=(74, 222, 128), outline=(22, 101, 52), width=2)


# ------------------------------------------------------------- morning swaps story

def bathroom_bg(f):
    d = ImageDraw.Draw(f)
    d.rectangle((0, 0, W, GROUND), fill=(224, 242, 254))
    for x in range(0, W, 120):
        d.line((x, 0, x, GROUND), fill=(186, 230, 253), width=4)
    for y in range(0, GROUND, 120):
        d.line((0, y, W, y), fill=(186, 230, 253), width=4)
    d.rectangle((0, GROUND, W, H), fill=(148, 163, 184))
    d.rounded_rectangle((560, 330, 900, 700), 30, fill=(240, 249, 255), outline=INK, width=8)  # mirror
    d.line((610, 380, 680, 450), fill=(255, 255, 255), width=10)
    d.rectangle((700, 1000, 760, GROUND), fill=(241, 245, 249), outline=INK, width=5)  # pedestal
    d.chord((560, 880, 900, 1080), 0, 180, fill=(255, 255, 255), outline=INK, width=6)  # basin
    d.rectangle((560, 960, 900, 985), fill=(255, 255, 255), outline=INK, width=6)
    d.rectangle((715, 790, 745, 880), fill=(156, 163, 175), outline=INK, width=4)  # tap
    d.rounded_rectangle((690, 770, 820, 805), 14, fill=(156, 163, 175), outline=INK, width=4)
    d.ellipse((700, 745, 760, 775), fill=(239, 68, 68), outline=INK, width=3)


def water(f, flow, t):
    if flow <= 0:
        return
    d = ImageDraw.Draw(f, "RGBA")
    w = 26 * flow
    d.rectangle((805 - w / 2, 805, 805 + w / 2, 965), fill=(56, 189, 248, 210))
    for k in range(6):
        y = 805 + ((t * 500 + k * 30) % 160)
        d.ellipse((805 - 9, y - 9, 805 + 9, y + 9), fill=(186, 230, 253, 230))
    for k in range(5):
        a = math.pi + k * 0.6 + 0.2
        r = 30 + (t * 90 + k * 13) % 40
        d.ellipse((805 + math.cos(a) * r - 7, 965 + math.sin(a) * r * 0.5 - 7, 805 + math.cos(a) * r + 7, 965 + math.sin(a) * r * 0.5 + 7), fill=(56, 189, 248, 200))


def scene_tap(f, lt, D, t, buddy, lv, sp):
    bathroom_bg(f)
    off_at = D * 0.5
    flow = 1.0 if lt < off_at else clamp(1 - (lt - off_at) / 0.3)
    water(f, flow, t)
    reach = clamp((lt - off_at + 0.4) / 0.4)
    draw_kid(f, "boy", lerp(380, 520, reach), GROUND + 80, t, arm=1.0 if lt > off_at - 0.4 else 0.3, cheer=lt > off_at + 0.3)
    burst(f, 300, 600, 120, "TAP ON!", (239, 68, 68), (lt - 0.4) / 0.4 if lt < off_at else 0)
    burst(f, 330, 600, 135, "PAANI BACHAO!", (14, 165, 233), (lt - off_at - 0.2) / 0.4)
    buddy.draw(f, 960, 760, t, lv, mood="hot" if lt < off_at else "normal", scale=0.4)


def steel_bottle(d, x, y, s=1.0):
    d.rounded_rectangle((x - 34 * s, y - 70 * s, x + 34 * s, y + 90 * s), 26 * s, fill=(203, 213, 225), outline=INK, width=5)
    d.rectangle((x - 22 * s, y - 100 * s, x + 22 * s, y - 66 * s), fill=(71, 85, 105), outline=INK, width=4)
    d.rectangle((x - 30 * s, y - 40 * s, x - 20 * s, y + 60 * s), fill=(241, 245, 249))
    d.ellipse((x - 18 * s, y - 5 * s, x + 18 * s, y + 31 * s), fill=(34, 197, 94), outline=INK, width=3)


def scene_bottle(f, lt, D, t, buddy, lv, sp):
    room_bg(f)
    d = ImageDraw.Draw(f)
    bin_(d, 880, "dry", 0.0)
    swap = D * 0.42
    hx, hy = 650, GROUND - 175
    p = (lt - swap) / 0.6
    np_ = (lt - swap - 0.6) / 0.4
    draw_kid(f, "girl", 520, GROUND + 80, t, arm=1.0 if p >= 0 else 0.5, cheer=np_ > 0)
    if p < 0:
        draw_item(f, "bottle", hx, hy, rot=-15)
    elif p < 1:
        draw_item(f, "bottle", lerp(hx, 880, p), lerp(hy, GROUND - 300, p) - math.sin(p * math.pi) * 320, rot=p * 540)
    if np_ > 0:
        s = eb.pop(np_) if np_ < 1 else 1.0
        steel_bottle(ImageDraw.Draw(f), hx + 10, hy - 40, s)
        sparkles(f, hx + 10, hy - 40, t, spread=120, n=6)
    burst(f, 300, 640, 135, "STEEL BOTTLE!", (100, 116, 139), np_)
    buddy.draw(f, 810, 770, t, lv, mood="normal", scale=0.42)


def stall(d, t):
    d.rectangle((60, 820, 470, GROUND), fill=(180, 120, 70), outline=INK, width=6)
    for k in range(6):
        col = (239, 68, 68) if k % 2 == 0 else (255, 255, 255)
        d.polygon([(40 + k * 72, 720), (112 + k * 72, 720), (112 + k * 72, 820), (40 + k * 72, 820)], fill=col, outline=INK)
    for k in range(6):
        cx = 110 + k * 62
        d.ellipse((cx - 28, 860 - 28, cx + 28, 860 + 28), fill=[(239, 68, 68), (250, 204, 21), (34, 197, 94)][k % 3], outline=INK, width=3)


def jute_bag(d, x, y, s=1.0):
    d.arc((x - 50 * s, y - 120 * s, x + 50 * s, y - 20 * s), 180, 360, fill=(120, 80, 40), width=int(10 * s))
    d.polygon([(x - 80 * s, y - 70 * s), (x + 80 * s, y - 70 * s), (x + 95 * s, y + 90 * s), (x - 95 * s, y + 90 * s)], fill=(222, 196, 150), outline=INK, width=5)
    d.ellipse((x - 26 * s, y - 20 * s, x + 26 * s, y + 32 * s), fill=(34, 197, 94), outline=INK, width=3)


def scene_bag(f, lt, D, t, buddy, lv, sp):
    d = park(f, 1.0, t)
    stall(d, t)
    swap = D * 0.42
    hx, hy = 760, GROUND - 200
    p = (lt - swap) / 0.5
    if p < 0:
        draw_item(f, "bag", hx, hy, scale=0.9)
    elif p < 1:  # poof
        dd = ImageDraw.Draw(f, "RGBA")
        for k in range(8):
            a = k * math.pi / 4
            r = 40 + 90 * p
            dd.ellipse((hx + math.cos(a) * r - 40, hy + math.sin(a) * r - 40, hx + math.cos(a) * r + 40, hy + math.sin(a) * r + 40), fill=(255, 255, 255, int(220 * (1 - p))))
    np_ = (lt - swap - 0.4) / 0.4
    draw_kid(f, "boy", 680, GROUND + 80, t, arm=1.0 if np_ > 0 else 0.4, cheer=np_ > 0)
    if np_ > 0:
        jute_bag(ImageDraw.Draw(f), hx + 20, hy - 30, eb.pop(np_) if np_ < 1 else 1.0)
        sparkles(f, hx + 20, hy - 30, t, spread=140, n=6)
    burst(f, 640, 620, 120, "JHOLA!", (161, 98, 7), np_)
    buddy.draw(f, 960, GROUND + 60 - abs(math.sin(lt * 4)) * 25, t, lv, scale=0.55)


# ------------------------------------------------------------- battery news story

_BAT = None


def battery_sprite():
    global _BAT
    if _BAT is None:
        im = Image.new("RGBA", (70, 150), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        d.rectangle((24, 2, 46, 16), fill=(156, 163, 175), outline=INK, width=3)
        d.rounded_rectangle((6, 14, 64, 146), 12, fill=(30, 41, 59), outline=INK, width=4)
        d.rectangle((6, 14, 64, 60), fill=(34, 197, 94))
        d.line((35, 25, 35, 49), fill=(255, 255, 255), width=6)
        d.line((23, 37, 47, 37), fill=(255, 255, 255), width=6)
        _BAT = im
    return _BAT


def draw_battery(f, x, y, rot=0.0, scale=1.0):
    im = battery_sprite()
    if scale != 1:
        im = im.resize((max(2, int(im.width * scale)), max(2, int(im.height * scale))), Image.BICUBIC)
    if rot:
        im = im.rotate(rot, resample=Image.BICUBIC, expand=True)
    f.alpha_composite(im, (int(x - im.width / 2), int(y - im.height / 2)))


def tv(f, lt, t, headline):
    d = ImageDraw.Draw(f)
    x0, y0, x1, y1 = 140, 330, 940, 860
    d.rounded_rectangle((x0 - 30, y0 - 30, x1 + 30, y1 + 30), 36, fill=(31, 41, 55), outline=INK, width=8)
    d.rectangle((W / 2 - 120, y1 + 30, W / 2 + 120, y1 + 70), fill=(55, 65, 81))
    sw, sh = x1 - x0, y1 - y0
    scr = Image.new("RGBA", (sw, sh), (15, 23, 42, 255))
    s = ImageDraw.Draw(scr)
    for k in range(0, sh, 6):  # scanlines
        s.line((0, k, sw, k), fill=(30, 41, 59, 255), width=1)
    flash = (math.sin(t * 8) > 0)
    s.rectangle((0, 30, sw, 130), fill=(220, 38, 38) if flash else (185, 28, 28))
    s.text((sw / 2, 80), "BREAKING NEWS", font=eb.font(eb.FX, 74), fill=(255, 255, 255), anchor="mm")
    pulse = 1 + 0.1 * math.sin(t * 6)
    bat = battery_sprite().resize((int(110 * pulse), int(236 * pulse)), Image.BICUBIC)
    scr.alpha_composite(bat, (int(sw / 2 - bat.width / 2), int(150 + (230 - bat.height) / 2 + 20)))
    s.rectangle((0, sh - 110, sw, sh), fill=(250, 204, 21))
    fnt = eb.font(eb.FB, 52)
    text = ("   " + headline + "   •") * 3
    off = (lt * 260) % (s.textlength(headline + "      •", font=fnt))
    s.text((sw - 40 - off * 1.0 - 200, sh - 55), text, font=fnt, fill=INK, anchor="lm")
    f.alpha_composite(scr, (x0, y0))


def scene_news(f, lt, D, t, buddy, lv, sp):
    room_bg(f)
    tv(f, lt, t, sp.get("headline", "India needs a circular battery economy"))
    hop = abs(math.sin(lt * 5)) * 20 if lt > 0.5 else 0
    buddy.draw(f, W - 170, GROUND + 70 - hop, t, lv, scale=0.7)
    if lt > 1.0:
        outlined(ImageDraw.Draw(f), (W - 170, 1000 - 15 * math.sin(t * 6)), "!!", 110, (239, 68, 68), stroke=8)


def scene_xray(f, lt, D, t, buddy, lv, sp):
    f.alpha_composite(gradient((30, 27, 75), (76, 29, 149), H))
    d = ImageDraw.Draw(f, "RGBA")
    for k in range(40):  # star field
        x, y = (k * 197) % W, (k * 331) % GROUND
        d.ellipse((x - 3, y - 3, x + 3, y + 3), fill=(255, 255, 255, int(120 + 100 * math.sin(t * 3 + k))))
    p = eb.ease(lt / 0.6)
    bx0, by0, bx1, by1 = W / 2 - 230 * p, 420, W / 2 + 230 * p, 1180
    if p > 0.05:
        d.rectangle((W / 2 - 60, by0 - 60, W / 2 + 60, by0 + 4), fill=(203, 213, 225, 200), outline=(226, 232, 240), width=6)
        d.rounded_rectangle((bx0, by0, bx1, by1), 50, fill=(56, 189, 248, 50), outline=(186, 230, 253), width=10)
        sy = (lt * 600) % (by1 - by0) + by0  # x-ray scan line
        d.line((bx0 + 10, sy, bx1 - 10, sy), fill=(125, 211, 252, 200), width=8)
    orbs = [("Li", (250, 204, 21), 0), ("Co", (96, 165, 250), 1), ("Ni", (74, 222, 128), 2)]
    for name, col, k in orbs:
        op = eb.pop(clamp((lt - 0.7 - k * 0.35) / 0.4))
        if lt < 0.7 + k * 0.35:
            continue
        cx = W / 2 + math.cos(t * 1.8 + k * 2.09) * 120
        cy = 800 + math.sin(t * 2.4 + k * 2.09) * 220
        r = 85 * op
        g = Image.new("RGBA", (int(r * 4) + 2, int(r * 4) + 2), (0, 0, 0, 0))
        ImageDraw.Draw(g).ellipse((r, r, r * 3, r * 3), fill=col + (160,))
        g = g.filter(ImageFilter.GaussianBlur(r * 0.4))
        f.alpha_composite(g, (int(cx - g.width / 2), int(cy - g.height / 2)))
        dd = ImageDraw.Draw(f)
        dd.ellipse((cx - r, cy - r, cx + r, cy + r), fill=col, outline=INK, width=6)
        if op > 0.5:
            outlined(dd, (cx, cy), name, int(70 * op), (255, 255, 255), stroke=5)
    sparkles(f, W / 2, 800, t, spread=330, n=10)
    burst(f, 230, 380, 120, "KHAZANA!", (234, 179, 8), (lt - 1.9) / 0.4)
    buddy.draw(f, W - 140, GROUND + 80 - abs(math.sin(lt * 4)) * 25, t, lv, scale=0.55)


def scene_danger(f, lt, D, t, buddy, lv, sp):
    room_bg(f)
    d = ImageDraw.Draw(f)
    bx = 700
    shake = math.sin(t * 50) * 10 if lt > D * 0.3 else 0
    # dustbin
    d.polygon([(bx - 110 + shake, GROUND - 260), (bx + 110 + shake, GROUND - 260), (bx + 90 + shake, GROUND + 60), (bx - 90 + shake, GROUND + 60)], fill=(107, 114, 128), outline=INK, width=6)
    d.rounded_rectangle((bx - 125 + shake, GROUND - 300, bx + 125 + shake, GROUND - 255), 14, fill=(156, 163, 175), outline=INK, width=6)
    for k in range(3):
        d.line((bx - 50 + k * 50 + shake, GROUND - 220, bx - 45 + k * 50 + shake, GROUND + 30), fill=(75, 85, 99), width=6)
    if lt > D * 0.3:
        dd = ImageDraw.Draw(f, "RGBA")
        for k in range(7):  # smoke
            ph = (t * 0.8 + k / 7) % 1.0
            r = 40 + 70 * ph
            dd.ellipse((bx - r + math.sin(k + t) * 50, GROUND - 330 - ph * 420 - r, bx + r + math.sin(k + t) * 50, GROUND - 330 - ph * 420 + r), fill=(75, 85, 99, int(170 * (1 - ph))))
        if math.sin(t * 10) > 0:  # flashing warning
            d.polygon([(bx, 470), (bx + 110, 660), (bx - 110, 660)], fill=(250, 204, 21), outline=INK, width=8)
            outlined(d, (bx, 600), "!", 110, INK, stroke=0)
    hold = lt < D * 0.55
    draw_kid(f, "boy", 330, GROUND + 80, t, arm=0.9 if hold else 0.2, cheer=not hold)
    if hold:
        draw_battery(f, 440, GROUND - 330, rot=-25 + math.sin(t * 5) * 10, scale=0.8)
    else:  # battery safely set aside
        draw_battery(f, 200, GROUND + 40, rot=90, scale=0.7)
    pp = (lt - D * 0.25) / 0.4
    if pp > 0:
        draw_kid(f, "girl", lerp(W + 150, 940, eb.ease(pp)), GROUND + 80, t, arm=1.0, cheer=True)
    burst(f, 330, 560, 125, "RUKO!", (239, 68, 68), (lt - D * 0.35) / 0.35)
    buddy.draw(f, 810, 770, t, lv, mood="hot", scale=0.42)


def ev_car(d, x, y, t, s=1.0):
    d.rounded_rectangle((x - 220 * s, y - 110 * s, x + 220 * s, y), 40 * s, fill=(34, 197, 94), outline=INK, width=6)
    d.polygon([(x - 120 * s, y - 110 * s), (x - 70 * s, y - 200 * s), (x + 90 * s, y - 200 * s), (x + 150 * s, y - 110 * s)], fill=(187, 247, 208), outline=INK, width=6)
    d.line((x + 10 * s, y - 200 * s, x + 10 * s, y - 110 * s), fill=INK, width=6)
    for wx in (x - 130 * s, x + 130 * s):
        d.ellipse((wx - 50 * s, y - 50 * s, wx + 50 * s, y + 50 * s), fill=(31, 41, 55), outline=INK, width=6)
        for k in range(3):
            a = t * 12 + k * 2.09
            d.line((wx, y, wx + math.cos(a) * 40 * s, y + math.sin(a) * 40 * s), fill=(156, 163, 175), width=6)
    d.rounded_rectangle((x - 50 * s, y - 85 * s, x + 30 * s, y - 25 * s), 10 * s, fill=(30, 41, 59), outline=INK, width=4)
    d.rectangle((x - 50 * s, y - 85 * s, x - 10 * s, y - 25 * s), fill=(250, 204, 21))


def scene_ewaste(f, lt, D, t, buddy, lv, sp):
    d = park(f, 1.0, t)
    bx, by = 300, GROUND - 120
    d.rounded_rectangle((bx - 150, by - 200, bx + 150, by + 180), 24, fill=(220, 38, 38), outline=INK, width=8)
    d.rectangle((bx - 170, by - 240, bx + 170, by - 195), fill=(239, 68, 68), outline=INK, width=6)
    outlined(d, (bx, by - 120), "E-WASTE", 56, (255, 255, 255), stroke=5)
    recycle_symbol(d, bx, by + 40, 70, t * 120, col=(255, 255, 255))
    for k in range(4):  # batteries fly in
        p = (lt - 0.3 - k * 0.35) / 0.6
        if 0 < p < 1:
            sx = 900 - k * 40
            draw_battery(f, lerp(sx, bx, p), lerp(GROUND - 100, by - 230, p) - math.sin(p * math.pi) * 300, rot=p * 600, scale=0.6)
    cp = (lt - D * 0.3) / (D * 0.6)
    if cp > 0:
        ev_car(ImageDraw.Draw(f), lerp(-260, W + 260, clamp(cp)), GROUND + 80, t, 1.0)
        if 0.2 < cp < 0.9:
            burst(f, lerp(-260, W + 260, clamp(cp)), GROUND - 230, 95, "EV!", (34, 197, 94), 1.0)
    buddy.draw(f, W - 170, GROUND + 40 - abs(math.sin(lt * 4)) * 30, t, lv, scale=0.6)


SKY = ((125, 211, 252), (224, 242, 254))
STORIES = {
    # name: (scenes, extra pause after each line, preset backgrounds)
    "garmi": ([scene_title, scene_hot, scene_room, scene_kids, scene_cool, scene_party, scene_cta],
              [0.4, 0.5, 0.7, 1.4, 0.7, 0.8, 1.4],
              [SKY, ((251, 146, 60), (254, 215, 170)), None, None, None, None, None]),
    "battery": ([scene_title, scene_news, scene_xray, scene_danger, scene_ewaste, scene_happy, scene_cta],
                [0.3, 0.8, 1.0, 1.2, 1.2, 0.6, 1.2],
                [SKY, None, None, None, None, None, None]),
    "subah": ([scene_title, scene_tap, scene_bottle, scene_bag, scene_happy, scene_cta],
              [0.4, 1.5, 1.5, 1.5, 0.8, 1.4],
              [SKY, None, None, None, None, None]),
    "plastic": ([scene_title, scene_litter, scene_sort, scene_recycle, scene_happy, scene_cta],
                [0.4, 1.0, 2.2, 1.6, 0.8, 1.4],
                [SKY, None, None, None, None, None]),
}


def subtitle(f, text, p):
    if p <= 0 or not text:
        return
    d = ImageDraw.Draw(f)
    fnt, lines = eb.fit_lines(d, text, eb.FB, 50, W - 200, 2)
    lh = fnt.size + 12
    bh = len(lines) * lh + 40
    y0 = 1390
    a = int(225 * clamp(p * 3))
    d.rounded_rectangle((70, y0, W - 70, y0 + bh), 34, fill=(17, 24, 39, a))
    for i, ln in enumerate(lines):
        d.text((W / 2, y0 + 20 + i * lh), ln, font=fnt, fill=(255, 255, 255, a), anchor="ma")


def render(spec):
    ff = spec["ffmpeg"]
    work = spec["work"]
    os.makedirs(work, exist_ok=True)
    lines = spec["lines"]
    # Reel mode: punchier colours, big word captions, stickers, progress bar, faster voice.
    reel = bool(spec.get("reel"))
    if reel:
        import reel_fx as rf
        from PIL import ImageEnhance
        rf.setup(eb.font, eb.FX, eb.FB)
        try:
            spec["rate"] = f"{int(str(spec.get('rate', '+8%')).strip('%')) + 6:+d}%"
        except ValueError:
            spec["rate"] = "+14%"
    clips = []
    for i, ln in enumerate(lines):
        mp3 = os.path.join(work, f"c{i}.mp3")
        for attempt in range(4):
            try:
                asyncio.run(eb.tts(ln["say"], mp3, spec.get("voice", "hi-IN-SwaraNeural"), spec.get("rate", "+8%"), spec.get("pitch", "+18Hz")))
                break
            except Exception:
                if attempt == 3:
                    raise
        s = eb.decode(ff, mp3)
        clips.append((mp3, len(s) / 16000, eb.levels(s)))
        print(f"voice {i + 1}/{len(lines)}: {clips[-1][1]:.1f}s", flush=True)
    SCENES, PAD, BGS = STORIES[spec.get("story", "garmi")]
    durs = [c[1] + PAD[i] + 0.3 for i, c in enumerate(clips)]
    starts = [sum(durs[:i]) for i in range(len(durs))]
    total = sum(durs)

    buddy = Buddy(spec["mascot"], 470)
    bar = eb.logo_bar(spec)
    bar = bar.resize((int(bar.width * 0.62), int(bar.height * 0.62)), Image.LANCZOS)
    card = eb.logo_bar({"logo": spec["logo"]})
    bgs = [gradient(*b) if b else None for b in BGS]

    silent = os.path.join(work, "silent.mp4")
    pipe = subprocess.Popen([ff, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                             "-c:v", "libx264", "-preset", "slow", "-tune", "animation", "-crf", "16", "-profile:v", "high", "-g", "60", "-pix_fmt", "yuv420p", silent], stdin=subprocess.PIPE)
    prev_last = None
    n = int(total * FPS)
    preview = {int(x * FPS) for x in spec.get("preview", [])}
    for fi in range(n):
        if preview and fi not in preview:
            continue
        t = fi / FPS
        si = max(i for i in range(len(starts)) if starts[i] <= t + 1e-6)
        lt = t - starts[si]
        D = durs[si]
        voice_t = lt - 0.3
        lv_list = clips[si][2]
        idx = int(voice_t * FPS)
        lv = lv_list[idx] if 0 <= idx < len(lv_list) else 0.0
        f = (bgs[si].copy() if bgs[si] is not None else Image.new("RGBA", (W, H), (0, 0, 0, 255)))
        if SCENES[si] is scene_cta:
            SCENES[si](f, lt, D, t, buddy, lv, spec, card)
        else:
            SCENES[si](f, lt, D, t, buddy, lv, spec)
        f.alpha_composite(bar, ((W - bar.width) // 2, 40))
        if reel:
            f = ImageEnhance.Color(f.convert("RGB")).enhance(1.3).convert("RGBA")
            if voice_t > 0:
                rf.captions(f, lines[si].get("sub", ""), voice_t / max(0.1, clips[si][1] * 0.95), 1470)
        else:
            subtitle(f, lines[si].get("sub", ""), voice_t / 0.4)
        # quick iris-style transition from black at each scene start
        if lt < 0.25 and si > 0 and not reel:
            k = lt / 0.25
            m = Image.new("L", (W, H), 0)
            r = int(lerp(0, 1200, eb.ease(k)))
            ImageDraw.Draw(m).ellipse((W / 2 - r, H / 2 - r, W / 2 + r, H / 2 + r), fill=255)
            black = Image.new("RGBA", (W, H), (20, 20, 30, 255))
            f = Image.composite(f, black, m)
        if t > total - 0.4:
            f = Image.blend(Image.new("RGBA", (W, H), (0, 0, 0, 255)), f, clamp((total - t) / 0.4))
        if reel:
            f = f.convert("RGB")
            rf.progress(f, starts, [(None, d) for d in durs], 0.0, t, rf.accent(si))
            if 0.6 <= t < 3.8:
                rf.sticker(f, "WATCH TILL THE END", t - 0.6, W - 250, 200)
            if SCENES[si] is scene_cta:
                rf.sticker(f, "FOLLOW FOR MORE", lt - 0.3, W // 2, 200, bg=(255, 46, 136), fg=(255, 255, 255), angle=4, size=50)
            elif si == len(SCENES) - 2 and lt > 0.4:
                rf.sticker(f, "SAVE THIS", lt - 0.4, 200, 200, bg=(0, 214, 143), angle=5)
            if si > 0:
                f = rf.punch(f, lt)
        if preview:
            f.convert("RGB").resize((360, 640)).save(os.path.join(work, f"prev_{fi:04d}.jpg"))
            continue
        pipe.stdin.write(f.convert("RGB").tobytes())
    pipe.stdin.close()
    pipe.wait()
    if preview:
        print(json.dumps({"preview": sorted(preview)}))
        return

    # Convert every sound to plain 48 kHz stereo WAV first: mixing mono voice with an
    # MP3 music loop directly makes ffmpeg fail to pick a channel layout.
    def wav(src, dst, extra=()):
        subprocess.run([ff, "-y", "-loglevel", "error", *extra, "-i", src, "-t", f"{total + 1:.2f}", "-ac", "2", "-ar", "48000", dst], check=True)
        return dst
    inputs, filt = [], []
    for i, (mp3, _, _) in enumerate(clips):
        inputs += ["-i", wav(mp3, os.path.join(work, f"c{i}.wav"))]
        ms = int((starts[i] + 0.3) * 1000)
        filt.append(f"[{i + 1}:a]adelay={ms}|{ms}[v{i}]")
    k = len(clips)
    mix_in = "".join(f"[v{i}]" for i in range(k))
    music = spec.get("music")
    if music and os.path.exists(music):
        inputs += ["-i", wav(music, os.path.join(work, "music.wav"), ("-stream_loop", "-1"))]
        filt.append(f"[{k + 1}:a]volume=0.16,afade=t=in:d=0.5,afade=t=out:st={total - 1.5:.2f}:d=1.5[m]")
        mix_in += "[m]"
        k += 1
    filt.append(f"{mix_in}amix=inputs={k}:duration=longest:normalize=0,atrim=0:{total:.2f},loudnorm=I=-15:TP=-1.5:LRA=11,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a]")
    out = spec["out"]
    subprocess.run([ff, "-y", "-loglevel", "error", "-i", silent, *inputs, "-filter_complex", ";".join(filt), "-map", "0:v", "-map", "[a]",
                    "-c:v", "copy", "-c:a", "aac", "-ar", "48000", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out], check=True)
    print(json.dumps({"file": out, "durationSec": round(total, 1)}), flush=True)


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as fh:
        render(json.load(fh))
