"""Reel mode: the bright, fast Instagram-reel look for every Earth Buddy video.

Turned on with "reel": true in the spec. It adds:
  - bold two-colour gradient backgrounds that change on every scene (a pattern break
    every few seconds keeps people watching), with drifting sparkles;
  - big word-by-word captions (current word in yellow), replacing the speech bubble;
  - a zoom punch + flash on every scene change;
  - "watch till the end" / "follow for more" stickers;
  - a thick progress bar.
"""
import math
import random

from PIL import Image, ImageDraw, ImageFilter

W, H = 1080, 1920
_font = None
_FX = _FB = None

# (top-left colour, bottom-right colour, glow colour, accent for the progress bar)
PALETTES = [
    ((255, 46, 136), (124, 58, 237), (255, 140, 200), (255, 230, 0)),    # candy: pink -> violet
    ((255, 149, 0), (255, 45, 85), (255, 210, 120), (255, 255, 255)),     # mango: orange -> red-pink
    ((0, 194, 255), (79, 70, 229), (140, 230, 255), (255, 230, 0)),       # electric: cyan -> indigo
    ((0, 214, 143), (0, 140, 255), (150, 255, 210), (255, 230, 0)),       # mint: green -> blue
    ((250, 204, 21), (249, 115, 22), (255, 245, 170), (124, 58, 237)),    # sunshine: yellow -> orange
    ((168, 85, 247), (236, 72, 153), (220, 170, 255), (255, 230, 0)),     # grape: purple -> pink
]
YELLOW, BLACK, WHITE = (255, 230, 0), (12, 12, 20), (255, 255, 255)


def setup(font_fn, fx_path, fb_path):
    global _font, _FX, _FB
    _font, _FX, _FB = font_fn, fx_path, fb_path


def _diag(a, b):
    """Diagonal two-colour gradient."""
    g = Image.linear_gradient("L").rotate(-35, resample=Image.BICUBIC, expand=True)
    g = g.resize((int(W * 1.6), int(H * 1.6))).crop((int(W * 0.3), int(H * 0.3), int(W * 0.3) + W, int(H * 0.3) + H))
    return Image.composite(Image.new("RGB", (W, H), b), Image.new("RGB", (W, H), a), g)


def background(idx, seed=0):
    top, bot, glow, _ = PALETTES[idx % len(PALETTES)]
    bg = _diag(top, bot)
    r = random.Random(seed * 31 + idx)
    m = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(m)
    for _ in range(4):
        cx, cy, rad = r.uniform(-100, W + 100), r.uniform(200, H), r.uniform(220, 420)
        d.ellipse((cx - rad, cy - rad, cx + rad, cy + rad), fill=int(r.uniform(60, 110)))
    bg.paste(Image.new("RGB", (W, H), glow), (0, 0), m.filter(ImageFilter.GaussianBlur(90)))
    # A few faint big rings for depth.
    d2 = ImageDraw.Draw(bg)
    for _ in range(3):
        cx, cy, rad = r.uniform(0, W), r.uniform(300, H), r.uniform(160, 360)
        d2.ellipse((cx - rad, cy - rad, cx + rad, cy + rad), outline=tuple(min(255, c + 40) for c in glow), width=6)
    return bg


def accent(idx):
    return PALETTES[idx % len(PALETTES)][3]


def make_sparkles(seed):
    r = random.Random(seed + 99)
    return [(r.uniform(0, W), r.uniform(0, H), r.uniform(40, 110), r.uniform(7, 16), r.uniform(0, 6.28)) for _ in range(16)]


def sparkles(frame, parts, tt):
    d = ImageDraw.Draw(frame)
    for x0, y0, sp, sz, ph in parts:
        y = (y0 - tt * sp) % (H + 80) - 40
        if y < 240:
            continue
        x = x0 + 30 * math.sin(tt * 1.3 + ph)
        tw = 0.55 + 0.45 * math.sin(tt * 4 + ph * 3)
        s = sz * tw
        if s < 2:
            continue
        # Four-point star.
        d.polygon([(x, y - s * 2), (x + s * 0.45, y - s * 0.45), (x + s * 2, y), (x + s * 0.45, y + s * 0.45),
                   (x, y + s * 2), (x - s * 0.45, y + s * 0.45), (x - s * 2, y), (x - s * 0.45, y - s * 0.45)], fill=WHITE)


def punch(frame, local, length=0.22):
    """Zoom-in punch and white flash during the first moments of a scene."""
    if local >= length or local < 0:
        return frame
    k = 1 - local / length
    s = 1 + 0.07 * k * k
    if s > 1.002:
        nw, nh = int(W * s), int(H * s)
        big = frame.resize((nw, nh), Image.BILINEAR)
        frame = big.crop(((nw - W) // 2, (nh - H) // 2, (nw - W) // 2 + W, (nh - H) // 2 + H))
    return Image.blend(frame, Image.new("RGB", (W, H), WHITE), 0.35 * k * k)


def _chunks(words, size=3):
    out, cur = [], []
    for w in words:
        cur.append(w)
        # Break after punctuation or when the chunk is full.
        if len(cur) >= size or w[-1:] in ".,!?;:":
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return out


def captions(frame, text, frac, cy):
    """Big word-by-word captions centred on cy; the word being said is yellow and lifted."""
    words = text.split()
    if not words:
        return
    n_said = max(1, min(len(words), math.ceil(len(words) * max(0.0, min(1.0, frac)))))
    chunks = _chunks(words)
    k, idx_in, start = 0, 0, 0
    for ci, ch in enumerate(chunks):
        if n_said <= start + len(ch):
            k, idx_in = ci, n_said - 1 - start
            break
        start += len(ch)
    chunk = chunks[k]
    d = ImageDraw.Draw(frame)
    size = 96
    while size > 56:
        f = _font(_FX, size)
        if d.textlength(" ".join(chunk).upper(), font=f) <= W - 120:
            break
        size -= 6
    f = _font(_FX, size)
    lines = [chunk]
    if d.textlength(" ".join(chunk).upper(), font=f) > W - 120 and len(chunk) > 1:
        lines = [chunk[: (len(chunk) + 1) // 2], chunk[(len(chunk) + 1) // 2:]]
    lh = int(size * 1.15)
    y0 = cy - lh * len(lines) // 2
    i = 0
    for li, ln in enumerate(lines):
        line = " ".join(ln).upper()
        x = (W - d.textlength(line, font=f)) / 2
        for wd in ln:
            up = wd.upper()
            now = i == idx_in
            fill = YELLOW if now else WHITE
            dy = -10 if now else 0
            d.text((x, y0 + li * lh + dy), up, font=f, fill=fill, stroke_width=max(6, size // 10), stroke_fill=BLACK)
            x += d.textlength(up + " ", font=f)
            i += 1


_stickers = {}


def sticker(frame, text, t, x, y, bg=YELLOW, fg=BLACK, angle=-6, size=44):
    """A tilted label that pops in and wobbles. t = seconds since it appeared."""
    if t < 0:
        return
    key = (text, bg, fg, size)
    if key not in _stickers:
        f = _font(_FB, size)
        tw = int(ImageDraw.Draw(Image.new("RGB", (1, 1))).textlength(text, font=f))
        im = Image.new("RGBA", (tw + 60, size + 44), (0, 0, 0, 0))
        dd = ImageDraw.Draw(im)
        dd.rounded_rectangle((4, 6, im.width - 1, im.height - 1), 22, fill=(0, 0, 0, 120))
        dd.rounded_rectangle((0, 0, im.width - 5, im.height - 7), 22, fill=bg, outline=BLACK, width=4)
        dd.text(((im.width - 5) // 2, (im.height - 7) // 2), text, font=f, fill=fg, anchor="mm")
        _stickers[key] = im
    im = _stickers[key]
    pop = min(1.0, t / 0.25)
    s = 0.4 + 0.6 * pop + 0.12 * math.sin(math.pi * pop) if pop < 1 else 1.0
    a = angle + 3 * math.sin(t * 5)
    r = im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))), Image.BICUBIC).rotate(a, resample=Image.BICUBIC, expand=True)
    frame.paste(r, (int(x - r.width / 2), int(y - r.height / 2)), r)


def progress(frame, starts, clips, gap, tt, color):
    d = ImageDraw.Draw(frame)
    n = len(starts)
    g, x0, total = 8, 40, W - 80
    seg = (total - g * (n - 1)) / n
    for i in range(n):
        x = x0 + i * (seg + g)
        fr = max(0.0, min(1.0, (tt - starts[i]) / max(0.1, clips[i][1] + gap)))
        d.rounded_rectangle((x, 14, x + seg, 30), 8, fill=(30, 30, 45))
        if fr > 0:
            d.rounded_rectangle((x, 14, x + max(16, seg * fr), 30), 8, fill=color, outline=BLACK, width=2)
