"""Earth Buddy video renderer.

Renders a vertical (1080x1920) MP4 where the Earth Buddy mascot speaks each
scene (edge-tts voice, mouth driven by loudness) over one of several visual
styles, so every post gets a different-looking video.

Usage: python earth_buddy.py spec.json
The spec is written by src/lib/video/buddy.ts; see that file for the fields.

Styles: cards (info cards with count-ups), kinetic (big words popping in),
list (a checklist that builds up), phone (app screens in a phone frame),
chat (messages popping into a chat, with a typing indicator), notes (a notes
page that types itself, ticking boxes as it goes).
Every style also gets story-style progress segments at the top and, on the
light backgrounds, a few drifting leaves.
Pillow draws every frame and pipes it to ffmpeg.
"""
import array, asyncio, json, math, os, re, subprocess, sys
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

import edge_tts

W, H, FPS = 1080, 1920, 30
GAP = 0.4
FONT_DIR = r"C:\Windows\Fonts"
FB = os.path.join(FONT_DIR, "segoeuib.ttf")
FS = os.path.join(FONT_DIR, "seguisb.ttf")
FR = os.path.join(FONT_DIR, "segoeui.ttf")
FX = os.path.join(FONT_DIR, "seguibl.ttf") if os.path.exists(os.path.join(FONT_DIR, "seguibl.ttf")) else FB

THEMES = {
    "forest": {"top": (236, 253, 243), "bot": (209, 243, 220), "blob": (187, 247, 208), "ink": (20, 83, 45), "accent": (234, 179, 8), "accent_ink": (20, 83, 45), "big": (161, 98, 7), "kinetic": [(20, 83, 45), (21, 128, 61), (161, 98, 7)]},
    "night": {"top": (5, 46, 22), "bot": (20, 83, 45), "blob": (22, 101, 52), "ink": (255, 255, 255), "accent": (250, 204, 21), "accent_ink": (5, 46, 22), "big": (202, 138, 4), "kinetic": [(5, 46, 22), (6, 78, 59), (20, 83, 45)]},
    "sky": {"top": (240, 249, 255), "bot": (186, 230, 253), "blob": (125, 211, 252), "ink": (12, 74, 110), "accent": (34, 197, 94), "accent_ink": (255, 255, 255), "big": (3, 105, 161), "kinetic": [(3, 105, 161), (21, 128, 61), (14, 116, 144)]},
    "sunset": {"top": (255, 247, 237), "bot": (254, 215, 170), "blob": (253, 186, 116), "ink": (124, 45, 18), "accent": (21, 128, 61), "accent_ink": (255, 255, 255), "big": (194, 65, 12), "kinetic": [(154, 52, 18), (21, 128, 61), (180, 83, 9)]},
}
CARD_INK, MUTED = (20, 40, 28), (90, 105, 95)

_fonts = {}


def font(path, size):
    key = (path, size)
    if key not in _fonts:
        _fonts[key] = ImageFont.truetype(path, size)
    return _fonts[key]


def wrap(draw, text, fnt, width):
    lines, cur = [], ""
    for word in text.split():
        t = (cur + " " + word).strip()
        if draw.textlength(t, font=fnt) <= width:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines


def fit_lines(draw, text, path, size, width, max_lines, min_size=34):
    while size > min_size:
        f = font(path, size)
        lines = wrap(draw, text, f, width)
        if len(lines) <= max_lines:
            return f, lines
        size -= 4
    f = font(path, min_size)
    return f, wrap(draw, text, f, width)[:max_lines]


def indian(n):
    s = str(int(round(n)))
    if len(s) <= 3:
        return s
    head, tail, parts = s[:-3], s[-3:], []
    while len(head) > 2:
        parts.insert(0, head[-2:])
        head = head[:-2]
    if head:
        parts.insert(0, head)
    return ",".join(parts) + "," + tail


def ease(t):
    t = max(0.0, min(1.0, t))
    return 1 - (1 - t) ** 3


def pop(t):
    """Overshoot pop-in 0..1 -> scale 0.6..1.08..1."""
    t = max(0.0, min(1.0, t))
    return 0.6 + 0.4 * t + 0.18 * math.sin(math.pi * t) * (1 - t)


# ---------------------------------------------------------------- audio

async def tts(text, path, voice, rate, pitch):
    await edge_tts.Communicate(text, voice, rate=rate, pitch=pitch).save(path)


async def _tts_words(text, path, voice, rate, pitch):
    words = []
    c = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, boundary="WordBoundary")
    with open(path, "wb") as f:
        async for ch in c.stream():
            if ch["type"] == "audio":
                f.write(ch["data"])
            elif ch["type"] == "WordBoundary":
                s = ch["offset"] / 1e7
                words.append((s, s + ch["duration"] / 1e7, ch["text"]))
    return words


def tts_words(text, path, voice, rate, pitch, tries=4):
    """Speaks `text` into `path`; returns [(start, end, word)] in seconds. Retries network hiccups."""
    for attempt in range(tries):
        try:
            return asyncio.run(_tts_words(text, path, voice, rate, pitch))
        except Exception:
            if attempt == tries - 1:
                raise


def decode(ffmpeg, mp3):
    raw = subprocess.run([ffmpeg, "-loglevel", "error", "-i", mp3, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"], check=True, capture_output=True).stdout
    a = array.array("h")
    a.frombytes(raw[: len(raw) // 2 * 2])
    return a


def levels(samples, sr=16000):
    per = sr // FPS
    out = []
    for i in range(0, len(samples), per):
        chunk = samples[i:i + per]
        out.append(math.sqrt(sum(x * x for x in chunk) / max(1, len(chunk))) if chunk else 0.0)
    peak = max(out) if out and max(out) > 0 else 1.0
    return [min(1.0, (v / peak) * 1.6) for v in out]


# ---------------------------------------------------------------- shared art

def cutout(path):
    im = Image.open(path).convert("RGB")
    marker = (255, 0, 255)
    work = im.copy()
    w, h = work.size
    for seed in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1), (w // 2, 0), (w // 2, h - 1), (0, h // 2), (w - 1, h // 2)]:
        if work.getpixel(seed) != marker:
            ImageDraw.floodfill(work, seed, marker, thresh=40)
    mask = Image.new("L", (w, h), 255)
    mp, wp = mask.load(), work.load()
    for y in range(h):
        for x in range(w):
            if wp[x, y] == marker:
                mp[x, y] = 0
    im.putalpha(mask.filter(ImageFilter.GaussianBlur(1.2)))
    return im


def open_mouth(base, level, box):
    x0, y0, x1, y1 = box
    if level < 0.06:
        return base
    img = base.copy()
    region = base.crop((x0, y0, x1, y1))
    nh = int((y1 - y0) * (1.0 + 0.55 * level))
    stretched = region.resize((x1 - x0, nh), Image.BICUBIC)
    m = Image.new("L", (x1 - x0, nh), 0)
    ImageDraw.Draw(m).ellipse((0, 0, x1 - x0 - 1, nh - 1), fill=255)
    img.paste(stretched, (x0, y0 - int((nh - (y1 - y0)) * 0.25)), m.filter(ImageFilter.GaussianBlur(6)))
    return img


def background(theme, seed=0):
    bg = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(bg)
    a, b = theme["top"], theme["bot"]
    for y in range(H):
        t = y / H
        d.line([(0, y), (W, y)], fill=tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3)))
    blob = Image.new("L", (W, H), 0)
    bd = ImageDraw.Draw(blob)
    spots = [[(-260, 1350, 420, 2030), (760, 120, 1360, 720), (820, 1500, 1300, 1980)],
             [(-200, 80, 380, 660), (700, 1300, 1400, 2000), (300, 900, 700, 1300)],
             [(600, -200, 1300, 500), (-300, 1500, 300, 2100), (850, 1000, 1250, 1400)]][seed % 3]
    for i, s in enumerate(spots):
        bd.ellipse(s, fill=(70, 50, 40)[i])
    bg.paste(Image.new("RGB", (W, H), theme["blob"]), (0, 0), blob.filter(ImageFilter.GaussianBlur(6)))
    return bg


def logo_bar(spec):
    bar = Image.new("RGBA", (W - 120, 170), (0, 0, 0, 0))
    ImageDraw.Draw(bar).rounded_rectangle((0, 0, bar.width - 1, bar.height - 1), 85, fill=(255, 255, 255, 240))
    kv = Image.open(spec["logo"]).convert("RGB")
    # The full logo has wide white margins; crop to the drawn area.
    gray = kv.convert("L").point(lambda v: 255 if v < 235 else 0)
    box = gray.getbbox() or (0, 0, kv.width, kv.height)
    kv = kv.crop(box)
    kv = kv.resize((int(kv.width * 130 / kv.height), 130))
    partner = spec.get("partnerLogo")
    if partner and os.path.exists(partner):
        pl = Image.open(partner).convert("RGB")
        pl = pl.resize((150, 150))
        bar.paste(pl, (40, 10))
        # A thin divider between the two logos (an "×" here looked like a close button).
        ImageDraw.Draw(bar).line((222, 45, 222, 125), fill=(203, 213, 207, 255), width=3)
        if kv.width > bar.width - 330:
            kv = kv.resize((bar.width - 330, int(130 * (bar.width - 330) / kv.width)))
        bar.paste(kv, (bar.width - kv.width - 50, (170 - kv.height) // 2))
    else:
        if kv.width > bar.width - 80:
            kv = kv.resize((bar.width - 80, int(130 * (bar.width - 80) / kv.width)))
        bar.paste(kv, ((bar.width - kv.width) // 2, (170 - kv.height) // 2))
    return bar


def white_card(w, h, radius=48):
    c = Image.new("RGBA", (w, h + 24), (0, 0, 0, 0))
    sh = Image.new("RGBA", c.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((10, 18, w - 10, h + 20), radius, fill=(0, 0, 0, 55))
    c = Image.alpha_composite(c, sh.filter(ImageFilter.GaussianBlur(14)))
    ImageDraw.Draw(c).rounded_rectangle((0, 0, w - 1, h - 1), radius, fill=(255, 255, 255, 255))
    return c


def pill(d, cx, y, text, theme, size=38):
    f = font(FB, size)
    tw = d.textlength(text, font=f)
    d.rounded_rectangle((cx - tw / 2 - 30, y, cx + tw / 2 + 30, y + size + 28), (size + 28) // 2, fill=theme["accent"])
    d.text((cx, y + (size + 28) / 2), text, font=f, fill=theme["accent_ink"], anchor="mm")


def bubble(text, frac, width, tail_x, highlight=False):
    f = font(FS, 46)
    tmp = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    words = text.split()
    n_shown = max(1, math.ceil(len(words) * frac))
    lines = wrap(tmp, text, f, width - 90)[:3]
    bh = 50 + 60 * len(lines)
    b = Image.new("RGBA", (width, bh + 50), (0, 0, 0, 0))
    d = ImageDraw.Draw(b)
    d.rounded_rectangle((0, 0, width - 1, bh), 34, fill=(255, 255, 255, 255), outline=(20, 83, 45), width=5)
    tx = max(60, min(width - 60, tail_x))
    d.polygon([(tx - 34, bh - 3), (tx + 34, bh - 3), (tx - 6, bh + 46)], fill=(255, 255, 255, 255))
    d.line([(tx - 34, bh - 1), (tx - 6, bh + 46), (tx + 34, bh - 1)], fill=(20, 83, 45), width=5)
    # Words appear as they are spoken; the word being said now is green and bold.
    k = 0
    for i, ln in enumerate(lines):
        x = 45
        for wd in ln.split():
            if k >= n_shown:
                break
            now = highlight and k == n_shown - 1 and frac < 0.999
            d.text((x, 25 + i * 60), wd, font=font(FB, 46) if now else f, fill=(21, 128, 61) if now else (17, 24, 39))
            x += d.textlength(wd + " ", font=f)
            k += 1
    return b


def cta_card(spec, theme, w=W - 120, h=640):
    c = white_card(w, h)
    d = ImageDraw.Draw(c)
    cx = w // 2
    kv = Image.open(spec["logo"]).convert("RGB")
    gray = kv.convert("L").point(lambda v: 255 if v < 235 else 0)
    kv = kv.crop(gray.getbbox() or (0, 0, kv.width, kv.height))
    kv = kv.resize((int(kv.width * 200 / kv.height), 200))
    if kv.width > w - 100:
        kv = kv.resize((w - 100, int(200 * (w - 100) / kv.width)))
    c.paste(kv, ((w - kv.width) // 2, 60))
    cta = spec.get("cta", {})
    f, lines = fit_lines(d, cta.get("line1", "Every Sustainable Gesture Counts"), FB, 52, w - 100, 2)
    y = 300
    for ln in lines:
        d.text((cx, y), ln, font=f, fill=CARD_INK, anchor="ma")
        y += f.size + 12
    bf, _ = fit_lines(d, cta.get("button", "Search KarmaVerse on Google Play"), FB, 44, w - 220, 1)
    d.rounded_rectangle((80, y + 30, w - 80, y + 140), 55, fill=theme["big"] if theme["ink"] == (255, 255, 255) else theme["ink"])
    d.text((cx, y + 85), cta.get("button", "Search KarmaVerse on Google Play"), font=bf, fill=(255, 255, 255), anchor="mm")
    d.text((cx, y + 175), cta.get("site", "karmaverse.earth"), font=font(FS, 40), fill=(21, 128, 61), anchor="ma")
    return c


# ---------------------------------------------------------------- style: cards

def card_for(scene, spec, theme, p):
    kind = scene.get("kind", "point")
    if kind == "cta":
        return cta_card(spec, theme)
    w, h = W - 120, 700
    c = white_card(w, h)
    d = ImageDraw.Draw(c)
    cx = w // 2
    e = ease(p / 0.55)
    if scene.get("label"):
        pill(d, cx, 55, scene["label"], theme)
    if kind == "stat" and scene.get("num") is not None:
        n = scene["num"] * e
        unit = scene.get("unit", "")
        big = f"{n / 100000:.1f} lakh{unit}" if scene.get("lakh") else f"{indian(n)}{(' ' + unit) if unit and unit not in '%+' else unit}"
        f = font(FX, 140)
        while d.textlength(big, font=f) > w - 80 and f.size > 60:
            f = font(FX, f.size - 6)
        d.text((cx, 220), big, font=f, fill=theme["big"] if theme["big"] else CARD_INK, anchor="ma")
        cf, lines = fit_lines(d, scene.get("cap", ""), FS, 54, w - 140, 3)
        for i, ln in enumerate(lines):
            d.text((cx, 420 + i * (cf.size + 14)), ln, font=cf, fill=CARD_INK, anchor="ma")
    elif kind == "quote":
        d.text((80, 20), "\u201c", font=font(FB, 220), fill=theme["accent"])
        qf, lines = fit_lines(d, scene.get("big", scene["text"]), FS, 58, w - 160, 6)
        y = 200
        for ln in lines:
            d.text((cx, y), ln, font=qf, fill=CARD_INK, anchor="ma")
            y += qf.size + 18
        if scene.get("cap"):
            d.line((cx - 150, y + 30, cx + 150, y + 30), fill=theme["accent"], width=4)
            d.text((cx, y + 60), scene["cap"], font=font(FR, 38), fill=MUTED, anchor="ma")
    else:
        top = 150 if scene.get("label") else 90
        hf, lines = fit_lines(d, scene.get("big") or scene["text"], FB, 76 if kind == "hook" else 64, w - 120, 6)
        total = len(lines) * (hf.size + 16)
        y = top + max(0, (h - top - 80 - total) // 2)
        shown = max(1, math.ceil(len(lines) * min(1.0, p / 0.35 + 0.01)))
        for ln in lines[:shown]:
            d.text((cx, y), ln, font=hf, fill=CARD_INK if kind != "question" else theme["big"], anchor="ma")
            y += hf.size + 16
        if scene.get("cap"):
            d.text((cx, y + 20), scene["cap"], font=font(FS, 42), fill=(21, 128, 61), anchor="ma")
        if kind == "question":
            d.text((cx, h - 110), "Comment below \u2193", font=font(FB, 44), fill=MUTED, anchor="ma")
    s = 0.9 + 0.1 * ease(p / 0.15)
    if s < 0.999:
        c = c.resize((int(c.width * s), int(c.height * s)), Image.BICUBIC)
    return c


# ---------------------------------------------------------------- style: kinetic

KEY = re.compile(r"(\d|%|lakh|crore|kg|free|earn|win|new|planet|climate|karma)", re.I)


def kinetic_frame(frame, scene, theme, p, color_idx):
    """Big words, popping in one by one, centred in the upper two-thirds."""
    d = ImageDraw.Draw(frame)
    text = scene.get("big") or scene["text"]
    words = text.split()
    f, lines = fit_lines(d, text, FX, 118, W - 140, 6, min_size=60)
    lh = f.size + 22
    total = len(lines) * lh
    y0 = 300 + max(0, (900 - total) // 2)
    reveal = p / 0.8
    k = 0
    for li, ln in enumerate(lines):
        ws = ln.split()
        widths = [d.textlength(w_ + " ", font=f) for w_ in ws]
        x = (W - sum(widths) + d.textlength(" ", font=f)) / 2
        for w_, ww in zip(ws, widths):
            t = reveal * len(words) - k
            if t > 0:
                s = pop(min(1.0, t * 1.4))
                hot = bool(KEY.search(w_))
                col = theme["accent"] if hot else (255, 255, 255)
                g = Image.new("RGBA", (int(ww * 1.3) + 20, int(lh * 1.4)), (0, 0, 0, 0))
                gd = ImageDraw.Draw(g)
                gd.text((10 + 4, 10 + 5), w_, font=f, fill=(0, 0, 0, 90))
                gd.text((10, 10), w_, font=f, fill=col)
                if s < 0.999:
                    g = g.resize((max(1, int(g.width * s)), max(1, int(g.height * s))), Image.BICUBIC)
                frame.paste(g, (int(x + (ww * (1 - s)) / 2) - 10, int(y0 + li * lh + (lh * (1 - s)) / 2) - 10), g)
            x += ww
            k += 1
    if scene.get("label"):
        pill(d, W // 2, y0 - 110, scene["label"], theme)


# ---------------------------------------------------------------- style: list

def list_panel(spec, theme, scenes, si, p):
    """A checklist of the point scenes, building up as Earth Buddy talks."""
    items = [i for i, s in enumerate(scenes) if s.get("kind") in ("point", "stat")]
    w, h = W - 120, 760
    c = white_card(w, h)
    d = ImageDraw.Draw(c)
    title = spec.get("title") or scenes[0].get("big") or scenes[0]["text"]
    tf, tl = fit_lines(d, title, FB, 58, w - 100, 2)
    y = 50
    for ln in tl:
        d.text((w // 2, y), ln, font=tf, fill=CARD_INK, anchor="ma")
        y += tf.size + 10
    y += 30
    shown = [i for i in items if i < si or (i == si)]
    room = h - y - 40
    row = min(150, room // max(1, len(items)))
    for n, i in enumerate(items):
        if i not in shown:
            break
        active = i == si
        a = ease(p / 0.25) if active else 1.0
        txt = scenes[i].get("big") or scenes[i]["text"]
        f, lines = fit_lines(d, txt, FS if not active else FB, 50, w - 220, 2, min_size=32)
        yy = y + n * row
        cx0 = 70 - int(40 * (1 - a))
        d.ellipse((cx0 - 32, yy + 4, cx0 + 32, yy + 68), fill=theme["accent"] if active else (220, 252, 231))
        d.text((cx0, yy + 36), str(n + 1), font=font(FB, 36), fill=theme["accent_ink"] if active else (21, 128, 61), anchor="mm")
        for k, ln in enumerate(lines):
            d.text((130, yy + 8 + k * (f.size + 6)), ln, font=f, fill=CARD_INK if active else MUTED)
    return c


# ---------------------------------------------------------------- style: phone

def phone_with(screen_path, w=470):
    scr = Image.open(screen_path).convert("RGB")
    h = int(w * 2.05)
    sw, sh = w - 36, h - 36
    scr = scr.resize((sw, int(scr.height * sw / scr.width)))
    if scr.height > sh:
        scr = scr.crop((0, 0, sw, sh))
    ph = Image.new("RGBA", (w + 40, h + 50), (0, 0, 0, 0))
    sh_ = Image.new("RGBA", ph.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh_).rounded_rectangle((20, 30, w + 20, h + 30), 60, fill=(0, 0, 0, 90))
    ph = Image.alpha_composite(ph, sh_.filter(ImageFilter.GaussianBlur(16)))
    d = ImageDraw.Draw(ph)
    d.rounded_rectangle((0, 0, w, h), 62, fill=(17, 24, 39))
    inner = Image.new("RGB", (sw, sh), (255, 255, 255))
    inner.paste(scr, (0, 0))
    m = Image.new("L", (sw, sh), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, sw - 1, sh - 1), 46, fill=255)
    ph.paste(inner, (18, 18), m)
    d.rounded_rectangle((w // 2 - 60, 30, w // 2 + 60, 52), 11, fill=(17, 24, 39))
    return ph


# ---------------------------------------------------------------- style: chat

PANEL_W, PANEL_H, PANEL_Y = W - 120, 1150, 250
TYPE = 0.45  # seconds of "typing…" before each message


def mix(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def chat_avatar(mascot, size=104):
    av = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(av).ellipse((0, 0, size - 1, size - 1), fill=(255, 255, 255, 255))
    head = mascot.crop((140, 0, mascot.width - 140, mascot.width - 280)).resize((size - 8, size - 8), Image.BICUBIC)
    m = Image.new("L", head.size, 0)
    ImageDraw.Draw(m).ellipse((0, 0, head.width - 1, head.height - 1), fill=255)
    av.paste(head, (4, 4), ImageChops.multiply(head.getchannel("A"), m))
    return av


def chat_bubble(scene, theme, idx):
    """One message from Earth Buddy: an optional coloured label, the text and a time stamp."""
    f = font(FS, 46)
    tmp = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    text = scene.get("big") or scene["text"]
    lines = wrap(tmp, text, f, 640)[:5]
    label = scene.get("label")
    lw = max([tmp.textlength(ln, font=f) for ln in lines] + [tmp.textlength(label or "", font=font(FB, 32)) + 10, 200])
    bw = int(lw) + 70
    bh = 40 + (48 if label else 0) + len(lines) * 58 + 40
    q = scene.get("kind") == "question"
    fill = (220, 248, 198) if q else (255, 255, 255)
    b = Image.new("RGBA", (bw + 16, bh + 16), (0, 0, 0, 0))
    d = ImageDraw.Draw(b)
    d.rounded_rectangle((6, 8, bw + 6, bh + 8), 30, fill=(0, 0, 0, 28))
    d.rounded_rectangle((0, 0, bw, bh), 30, fill=fill)
    d.polygon([(0, 18), (-1, 0), (26, 0)], fill=fill)
    y = 26
    if label:
        d.text((35, y), label, font=font(FB, 32), fill=theme["kinetic"][0])
        y += 48
    for ln in lines:
        d.text((35, y), ln, font=f, fill=(17, 24, 39))
        y += 58
    d.text((bw - 74, bh - 14), f"7:{10 + idx:02d} pm", font=font(FR, 28), fill=MUTED, anchor="rs")
    for k in (0, 12):  # blue "read" ticks
        x = bw - 62 + k
        d.line((x, bh - 26, x + 7, bh - 19, x + 20, bh - 34), fill=(83, 155, 220), width=3)
    return b


def chat_panel(theme, scenes, si, local, avatar, cache):
    w, h = PANEL_W, PANEL_H
    head = theme["kinetic"][0]
    c = white_card(w, h, 44)
    d = ImageDraw.Draw(c)
    d.rounded_rectangle((0, 0, w - 1, 150), 44, fill=head)
    d.rectangle((0, 100, w - 1, 150), fill=head)
    c.paste(avatar, (30, 23), avatar)
    typing = local < TYPE and scenes[si].get("kind") != "cta"
    d.text((160, 36), "Earth Buddy", font=font(FB, 46), fill=(255, 255, 255))
    d.text((160, 94), "typing…" if typing else "online", font=font(FR, 34), fill=(220, 252, 231))
    wall = mix(theme["top"], (255, 255, 255), 0.35) if theme["ink"] != (255, 255, 255) else (236, 242, 238)
    d.rectangle((0, 150, w - 1, h - 120), fill=wall)
    d.rounded_rectangle((24, h - 100, w - 130, h - 24), 38, fill=(241, 243, 245))
    d.text((60, h - 62), "Answer in the comments…", font=font(FR, 36), fill=MUTED, anchor="lm")
    d.ellipse((w - 106, h - 104, w - 24, h - 22), fill=theme["accent"])
    d.polygon([(w - 82, h - 82), (w - 82, h - 44), (w - 44, h - 63)], fill=(255, 255, 255))

    shown = [i for i in range(si + 1) if scenes[i].get("kind") != "cta"]
    y = h - 140
    items = []
    for i in reversed(shown):
        if i == si and typing:
            tb = Image.new("RGBA", (170, 86), (0, 0, 0, 0))
            td = ImageDraw.Draw(tb)
            td.rounded_rectangle((0, 0, 169, 85), 30, fill=(255, 255, 255))
            for k in range(3):
                dy = -12 * max(0.0, math.sin(local * 12 - k * 0.9))
                td.ellipse((38 + k * 36, 34 + dy, 58 + k * 36, 54 + dy), fill=(150, 160, 155))
            img = tb
        else:
            if i not in cache:
                cache[i] = chat_bubble(scenes[i], theme, i)
            img = cache[i]
            if i == si:
                s = pop(min(1.0, (local - TYPE) / 0.28))
                if s < 0.999 or s > 1.001:
                    img = img.resize((max(1, int(img.width * s)), max(1, int(img.height * s))), Image.BICUBIC)
        if y - img.height < 165:
            break
        items.append((img, y - img.height))
        y -= img.height + 22
    for img, yy in items:
        c.paste(img, (30, yy), img)
    return c


# ---------------------------------------------------------------- style: notes

PAPER, RULE, AMBER = (255, 251, 232), (238, 226, 190), (217, 119, 6)


def typed(text, frac):
    n = max(0, min(len(text), int(len(text) * frac)))
    return text[:n]


def notes_panel(theme, scenes, si, local, dur):
    """A notes page: the hook is the title, points are typed out and ticked off."""
    w, h = PANEL_W, PANEL_H
    c = white_card(w, h, 44)
    d = ImageDraw.Draw(c)
    d.rounded_rectangle((0, 0, w - 1, h - 1), 44, fill=PAPER)
    d.text((40, 44), "‹ Notes", font=font(FS, 40), fill=AMBER)
    d.text((w - 40, 44), "Done", font=font(FB, 40), fill=AMBER, anchor="ra")
    d.text((w // 2, 112), "Today", font=font(FR, 30), fill=(160, 150, 120), anchor="ma")
    frac = min(1.0, local / max(0.3, dur * 0.8))
    cursor = int(local * 2.5) % 2 == 0

    title = scenes[0].get("big") or scenes[0]["text"]
    tf, tl = fit_lines(d, title, FB, 62, w - 100, 3, min_size=44)
    t_show = typed(title, frac) if si == 0 else title
    y = 170
    drawn = 0
    for ln in tl:
        part = t_show[drawn:drawn + len(ln)].strip() if drawn < len(t_show) else ""
        d.text((50, y), part, font=tf, fill=(28, 25, 23))
        if si == 0 and cursor and part and len(t_show) < len(title) and drawn + len(ln) >= len(t_show):
            d.text((50 + d.textlength(part, font=tf) + 4, y), "|", font=tf, fill=AMBER)
        drawn += len(ln) + 1
        y += tf.size + 14
    y += 26
    for ry in range(y + 76, h - 30, 80):
        d.line((40, ry, w - 40, ry), fill=RULE, width=2)

    f = font(FS, 46)
    blocks = []
    for i in range(1, si + 1):
        sc = scenes[i]
        if sc.get("kind") == "cta":
            continue
        txt = sc.get("big") or sc["text"]
        lines = wrap(d, txt, f, w - 220)[:3]
        blocks.append((i, sc, txt, lines))
    # Scroll: keep the newest items that fit.
    room = h - 40 - y
    while blocks and sum(len(b[3]) * 80 + 10 for b in blocks) > room:
        blocks.pop(0)
    for i, sc, txt, lines in blocks:
        cur = i == si
        show = typed(txt, frac) if cur else txt
        q = sc.get("kind") == "question"
        if not q:
            done = not cur or local > dur * 0.85
            box = (50, y + 12, 104, y + 66)
            if done:
                s = ease((local - dur * 0.85) / 0.2) if cur else 1.0
                d.ellipse(box, fill=mix(PAPER, (34, 197, 94), s))
                d.line((62, y + 40, 74, y + 53, 94, y + 26), fill=(255, 255, 255), width=6, joint="curve")
            else:
                d.ellipse(box, outline=(190, 175, 140), width=4)
        drawn = 0
        for k, ln in enumerate(lines):
            part = show[drawn:drawn + len(ln)].strip() if drawn < len(show) else ""
            x = 130 if not q else 50
            if q and part:
                d.rectangle((x - 8, y + 18, x + d.textlength(part, font=f) + 8, y + 70), fill=(254, 240, 138))
            d.text((x, y + 14), part, font=f, fill=(28, 25, 23) if not q else (124, 45, 18))
            if cur and cursor and part and len(show) < len(txt) and drawn + len(ln) >= len(show):
                d.text((x + d.textlength(part, font=f) + 4, y + 14), "|", font=f, fill=AMBER)
            drawn += len(ln) + 1
            y += 80
        y += 10
    return c


# ---------------------------------------------------------------- shared motion

def progress(frame, theme, starts, clips, tt):
    """Story-style segments across the top, one per scene."""
    d = ImageDraw.Draw(frame)
    n = len(starts)
    gap, x0, total = 10, 60, W - 120
    seg = (total - gap * (n - 1)) / n
    empty = mix(theme["top"], theme["ink"], 0.18) if theme["ink"] != (255, 255, 255) else (60, 110, 80)
    for i in range(n):
        x = x0 + i * (seg + gap)
        fr = max(0.0, min(1.0, (tt - starts[i]) / max(0.1, clips[i][1] + GAP)))
        d.rounded_rectangle((x, 18, x + seg, 28), 5, fill=empty)
        if fr > 0:
            d.rounded_rectangle((x, 18, x + max(10, seg * fr), 28), 5, fill=theme["accent"])


def make_leaves(seed):
    import random
    r = random.Random(seed)
    return [(r.uniform(0, W), r.uniform(0, H), r.uniform(35, 80), r.uniform(16, 30), r.uniform(0, 6.28)) for _ in range(9)]


def leaves(frame, theme, parts, tt):
    d = ImageDraw.Draw(frame)
    col = mix(theme["blob"], theme["ink"], 0.22)
    for x0, y0, sp, sz, ph in parts:
        y = (y0 + tt * sp) % (H + 120) - 60
        if y < 250:  # keep clear of the logo bar
            continue
        x = x0 + 40 * math.sin(tt * 1.1 + ph)
        tilt = 0.5 * math.sin(tt * 1.7 + ph)
        dx, dy = sz * math.cos(tilt), sz * math.sin(tilt)
        d.polygon([(x - dx, y - dy), (x - dy * 0.45, y + dx * 0.45), (x + dx, y + dy), (x + dy * 0.45, y - dx * 0.45)], fill=col)


# ---------------------------------------------------------------- render

def render(spec):
    global GAP
    ffmpeg = spec["ffmpeg"]
    work = spec["work"]
    os.makedirs(work, exist_ok=True)
    theme = THEMES.get(spec.get("theme"), THEMES["forest"])
    style = spec.get("style", "cards")
    layout = spec.get("layout", "center")
    scenes = spec["scenes"]

    series = style in ("news", "quiz", "myth", "hack")
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import series_styles as ss
    # Reel mode: bright colours, big captions, punchy cuts and a faster voice.
    reel = bool(spec.get("reel"))
    if reel:
        import reel_fx as rf
        rf.setup(font, FX, FB)
        GAP = 0.25
        try:
            spec["rate"] = f"{int(str(spec.get('rate', '+4%')).strip('%')) + 6:+d}%"
        except ValueError:
            spec["rate"] = "+10%"
    clips = []
    for i, sc in enumerate(scenes):
        mp3 = os.path.join(work, f"s{i}.mp3")
        words = tts_words(sc["say"], mp3, spec.get("voice", "en-IN-NeerjaExpressiveNeural"), spec.get("rate", "+4%"), spec.get("pitch", "+12Hz"))
        samples = decode(ffmpeg, mp3)
        clips.append((mp3, len(samples) / 16000, levels(samples), words))
        print(f"voice {i + 1}/{len(scenes)}: {clips[-1][1]:.1f}s", flush=True)

    voice = os.path.join(work, "voice.wav")
    inputs, filt = [], []
    # A scene can hold after its line (e.g. a quiz countdown) before the next one starts.
    holds = [float(sc.get("hold", 0) or 0) for sc in scenes]
    for i, clip in enumerate(clips):
        inputs += ["-i", clip[0]]
        filt.append(f"[{i}:a]aresample=48000,apad=pad_dur={GAP + holds[i]}[a{i}]")
    filt.append("".join(f"[a{i}]" for i in range(len(clips))) + f"concat=n={len(clips)}:v=0:a=1[v]")
    subprocess.run([ffmpeg, "-y", "-loglevel", "error", *inputs, "-filter_complex", ";".join(filt), "-map", "[v]", voice], check=True)

    starts, t = [], 0.5
    for i, clip in enumerate(clips):
        starts.append(t)
        t += clip[1] + GAP + holds[i]
    total = t + 1.0

    seed = int(spec.get("seed", 0))
    bg = ss.news_bg(seed) if style == "news" else background(theme, seed)
    bar = logo_bar(spec)
    bg.paste(bar, (60, 50), bar)
    reel_bgs = []
    if reel:
        for k in range(len(rf.PALETTES)):
            b = rf.background(k, seed)
            b.paste(bar, (60, 50), bar)
            reel_bgs.append(b)
        stars = rf.make_sparkles(seed)
    # A character drawn with three mouth frames (closed, half, open) swaps frames by loudness;
    # the Earth Buddy photo has one image and its mouth is stretched instead.
    frames = [f for f in spec.get("frames", []) if os.path.exists(f)]
    mascot = cutout(frames[0] if len(frames) == 3 else spec["mascot"])
    talk = [cutout(f) for f in frames[1:]] if len(frames) == 3 else []
    mouth = tuple(spec.get("mouth", [448, 568, 664, 642]))

    # Mascot size and place depend on the layout; the bubble's tail points at its head.
    ms = {"phone": 0.36, "kinetic": 0.42, "chat": 0.3, "notes": 0.3, "news": 0.34, "quiz": 0.36, "myth": 0.4, "hack": 0.4}.get(style, 0.55)
    mw, mh = int(mascot.width * ms), int(mascot.height * ms)
    if style == "news":
        mx = W - mw - 20
    elif style in ("chat", "notes"):
        mx = 30 if layout == "left" else W - mw - 30
    elif style == "phone":
        mx = 30 if layout != "right" else W - mw - 30
    elif layout == "left":
        mx = 30
    elif layout == "right":
        mx = W - mw - 30
    else:
        mx = (W - mw) // 2 + 20
    my = H - mh - (70 if style == "news" else 4)
    rest = mascot.resize((mw, mh), Image.BICUBIC)
    talk_sized = [t.resize((mw, mh), Image.BICUBIC) for t in talk]
    kin_bgs = [Image.new("RGB", (W, H), c) for c in theme["kinetic"]]
    screens = [s for s in spec.get("screens", []) if os.path.exists(s)]
    phones = {}
    avatar = chat_avatar(mascot)
    bubbles = {}
    falling = make_leaves(seed)

    silent = os.path.join(work, "video.mp4")
    proc = subprocess.Popen([ffmpeg, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                             "-c:v", "libx264", "-preset", "slow", "-tune", "animation", "-crf", "16", "-profile:v", "high", "-g", "60", "-pix_fmt", "yuv420p", silent], stdin=subprocess.PIPE)
    steps = [i for i, s in enumerate(scenes) if s.get("kind") == "step"]
    ticker_text = (spec.get("ticker") or spec.get("title") or "").upper()
    nframes = int(total * FPS)
    cache = {}
    for fi in range(nframes):
        tt = fi / FPS
        si = max([i for i, s in enumerate(starts) if s <= tt + 0.2] or [0])
        sc = scenes[si]
        dur = clips[si][1]
        local = tt - starts[si]
        p = max(0.0, min(1.0, local / max(0.1, dur)))
        is_cta = sc.get("kind") == "cta"
        if reel and style != "news":
            bg = reel_bgs[(si + seed) % len(reel_bgs)]

        frac = ss.words_frac(clips[si][3], local)
        kind = sc.get("kind")
        if series and not is_cta and kind in ss.PANEL_KINDS[style]:
            frame = bg.copy()
            if style != "news":
                rf.sparkles(frame, stars, tt) if reel else leaves(frame, theme, falling, tt)
            if style == "news":
                panel, dx = ss.news_panel(sc, spec, local, dur, frac, si)
                ss.news_tag(frame, tt)
                frame.paste(panel, (60 + dx, 370), panel)
            elif style == "quiz":
                reveal = kind == "answer"
                panel = ss.quiz_panel(sc, local, dur, holds[si], reveal)
                frame.paste(panel, ((W - panel.width) // 2, 250 + int(60 * (1 - ease(local / 0.3)))), panel)
                hold = holds[si]
                if not reveal and hold > 0 and local > dur + GAP * 0.5:
                    ss.countdown(frame, W // 2, 1110, hold - (local - dur - GAP * 0.5), hold)
                if reveal:
                    ss.confetti(frame, local - 0.15)
            elif style == "myth":
                panel = ss.myth_panel(sc, local)
                sx, sy = ss.shake(local - 0.22)
                frame.paste(panel, ((W - panel.width) // 2 + sx, 260 + sy), panel)
                if kind == "fact":
                    ss.sparkles(frame, local, W // 2, 372, spread=300, flat=0.22)
            elif style == "hack":
                n = steps.index(si) + 1 if si in steps else len(steps)
                panel = ss.hack_panel(sc, local, dur, n, max(1, len(steps)), theme)
                slide = ease(local / 0.35)
                frame.paste(panel, ((W - panel.width) // 2 + int((1 - slide) * -W * 0.6), 260), panel)
                if kind == "payoff":
                    ss.sparkles(frame, local, W // 2, 372, spread=300, flat=0.22)
                    ss.confetti(frame, local - 0.1, seed=7)
        elif style == "news" and not is_cta:
            frame = bg.copy()
            ss.news_tag(frame, tt)
            key = ("card", si, round(min(p, 0.56), 2) if p < 0.56 else "done")
            if key not in cache:
                cache[key] = card_for(sc, spec, theme, p if p < 0.56 else 1.0)
            panel = cache[key]
            frame.paste(panel, ((W - panel.width) // 2, 370), panel)
        elif style == "kinetic" and not is_cta:
            if reel:
                frame = bg.copy()
                rf.sparkles(frame, stars, tt)
            else:
                frame = kin_bgs[si % len(kin_bgs)].copy()
                frame.paste(bar, (60, 50), bar)
            kinetic_frame(frame, sc, theme, p, si)
        else:
            frame = bg.copy()
            rf.sparkles(frame, stars, tt) if reel else leaves(frame, theme, falling, tt)
            panel = None
            # New scenes slide up a little as they arrive.
            rise = int(90 * (1 - ease(local / 0.35)))
            if is_cta:
                key = ("cta",)
                if key not in cache:
                    cache[key] = cta_card(spec, theme)
                panel = cache[key]
                s = 0.9 + 0.1 * ease(local / 0.4)
                if s < 0.999:
                    panel = panel.resize((int(panel.width * s), int(panel.height * s)), Image.BICUBIC)
                frame.paste(panel, ((W - panel.width) // 2, 270 + (700 - panel.height) // 2), panel)
            elif style == "list":
                key = ("list", si, round(min(p, 0.26), 2))
                if key not in cache:
                    cache[key] = list_panel(spec, theme, scenes, si, p)
                panel = cache[key]
                frame.paste(panel, ((W - panel.width) // 2, 250), panel)
            elif style == "chat":
                panel = chat_panel(theme, scenes, si, local, avatar, bubbles)
                frame.paste(panel, (60, PANEL_Y), panel)
            elif style == "notes":
                panel = notes_panel(theme, scenes, si, local, dur)
                frame.paste(panel, (60, PANEL_Y), panel)
            elif style == "phone" and screens:
                path = screens[si % len(screens)]
                if path not in phones:
                    phones[path] = phone_with(path)
                ph = phones[path]
                slide = ease(local / 0.45)
                px = (W - ph.width) // 2 + (150 if layout != "right" else -150)
                px = int(px + (1 - slide) * (W - px))
                frame.paste(ph, (px, 420), ph)
                label = sc.get("big") or sc["text"]
                d = ImageDraw.Draw(frame)
                lf, lines = fit_lines(d, label, FB, 58, W - 140, 2, min_size=40)
                for k, ln in enumerate(lines):
                    d.text((W // 2, 245 + k * (lf.size + 8)), ln, font=lf, fill=theme["ink"], anchor="ma")
            else:
                key = ("card", si, round(min(p, 0.56), 2) if p < 0.56 else "done")
                if key not in cache:
                    cache[key] = card_for(sc, spec, theme, p if p < 0.56 else 1.0)
                panel = cache[key]
                frame.paste(panel, ((W - panel.width) // 2, 255 + (724 - panel.height) // 2 + rise), panel)

        lv = clips[si][2]
        li = int(local * FPS)
        level = lv[li] if 0 <= li < len(lv) else 0.0
        bob = int(6 * math.sin(tt * 2.2))
        # Earth Buddy jumps when an answer or fact is revealed.
        if kind in ("answer", "fact", "payoff") and local < 0.7:
            bob -= int(70 * math.sin(math.pi * local / 0.7))
        enter = ease(tt / 0.6)
        if talk_sized:
            m = rest if level < 0.08 else talk_sized[0] if level < 0.35 else talk_sized[1]
        else:
            m = rest if level < 0.06 else open_mouth(mascot, level, mouth).resize((mw, mh), Image.BICUBIC)
        frame.paste(m, (mx, my + bob + int((1 - enter) * 300)), m)

        # Speech bubble (not in kinetic, where the big words are the subtitles).
        spoken = frac if frac is not None else local / max(0.1, dur * 0.92)
        if style == "news" and not is_cta:
            ss.caption_bar(frame, sc["text"], spoken)
            ss.ticker(frame, ticker_text, tt)
        elif reel and (style not in ("kinetic", "chat", "notes") or is_cta):
            # Big captions instead of the bubble; hidden during a quiz countdown.
            if not (holds[si] > 0 and local > dur + 0.1):
                rf.captions(frame, sc["text"], min(1.0, max(0.02, spoken)), max(1110, my - 70))
        elif style not in ("kinetic", "chat", "notes") or is_cta:
            if series or is_cta:
                b = bubble(sc["text"], min(1.0, max(0.02, spoken)), W - 120, mx + mw // 2 - 60, highlight=True)
                frame.paste(b, (60, max(1030 if series else 990, my - b.height + 50)), b)
            elif style == "phone":
                bw, bx, by = 560, (mx + mw - 40) if layout != "right" else 40, my - 40
                b = bubble(sc["text"], min(1.0, max(0.02, spoken)), bw, 60 if layout != "right" else bw - 60, highlight=True)
                frame.paste(b, (min(bx, W - bw - 20), max(980, by - b.height + 60)), b)
            else:
                b = bubble(sc["text"], min(1.0, max(0.02, spoken)), W - 120, mx + mw // 2 - 60, highlight=True)
                frame.paste(b, (60, max(990, my - b.height + 50)), b)
        if reel:
            rf.progress(frame, starts, clips, GAP, tt, rf.accent((si + seed) % len(rf.PALETTES)))
            if si > 0:
                frame = rf.punch(frame, local)
            if 0.6 <= tt < 3.8:
                rf.sticker(frame, "WATCH TILL THE END", tt - 0.6, W - 250, 236)
            if is_cta:
                rf.sticker(frame, "FOLLOW FOR MORE", local - 0.3, W // 2, 236, bg=(255, 46, 136), fg=(255, 255, 255), angle=4, size=50)
            elif si == len(scenes) - 2 and local > 0.4:
                rf.sticker(frame, "SAVE THIS", local - 0.4, 200, 236, bg=(0, 214, 143), angle=5)
        else:
            progress(frame, theme, starts, clips, tt)
        proc.stdin.write(frame.tobytes())
        if fi % 300 == 0:
            print(f"frame {fi}/{nframes}", flush=True)
    proc.stdin.close()
    if proc.wait() != 0:
        raise SystemExit("ffmpeg failed while encoding frames")

    lead = int(starts[0] * 1000)
    music = spec.get("music")
    out = spec["out"]
    sfx = None
    if spec.get("sfx", True):
        try:
            sfx = ss.sfx_track(ffmpeg, work, ss.sfx_events(style, scenes, starts, clips, GAP), total)
        except Exception as e:  # sound effects are a nice-to-have
            print(f"sound effects skipped: {e}", flush=True)
    # Every track is made plain 48 kHz stereo before mixing (mixing mono and stereo makes ffmpeg fail to pick a layout).
    st = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo"
    inputs = ["-i", silent, "-i", voice]
    filt = [f"[1:a]{st},adelay={lead}|{lead},apad[v]"]
    mix_in, n, idx = "[v]", 1, 2
    if music and os.path.exists(music):
        inputs += ["-stream_loop", "-1", "-i", music]
        filt.append(f"[{idx}:a]{st},volume={spec.get('musicVolume', 0.13)},afade=t=in:d=1,afade=t=out:st={total - 2:.2f}:d=2[m]")
        mix_in, n, idx = mix_in + "[m]", n + 1, idx + 1
    if sfx:
        inputs += ["-i", sfx]
        filt.append(f"[{idx}:a]{st},volume={spec.get('sfxVolume', 0.5)}[s]")
        mix_in, n, idx = mix_in + "[s]", n + 1, idx + 1
    filt.append(f"{mix_in}amix=inputs={n}:duration=first:normalize=0,atrim=0:{total:.2f},loudnorm=I=-15:TP=-1.5:LRA=11[a]" if n > 1
                else f"[v]atrim=0:{total:.2f},loudnorm=I=-15:TP=-1.5:LRA=11[a]")
    cmd = [ffmpeg, "-y", "-loglevel", "error", *inputs, "-filter_complex", ";".join(filt)]
    subprocess.run(cmd + ["-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-ar", "48000", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out], check=True)
    print(json.dumps({"file": out, "durationSec": round(total, 1), "scenes": len(scenes)}), flush=True)


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as f:
        render(json.load(f))
