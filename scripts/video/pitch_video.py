"""Investor pitch video (1080x1920, 9:16), presented by Earth Buddy.

Usage: python scripts/video/pitch_video.py data/pitch/karmaverse-pitch.json

The spec lists `lines`; each line is spoken by Earth Buddy (edge-tts) and has a
`visual` that fills the main area while it is said. Visuals sharing a `group`
stay on screen across lines (no slide-in between them). Words in a visual's
`keys` make things pop in exactly when that word is spoken.

Visual types:
  corner     the "one corner" of old things (stage: intro | paid | stuck | karma)
  brand      big KarmaVerse logo
  badges     3R ZeroWaste credentials, popping in on keywords
  counter    a number that counts up (value, label, source)
  ring       a percentage ring (value, label)
  questions  three question cards
  demo       real app footage in a phone (segs: [{file, from, to} | {image, secs}]), with feature chips
  model      business model flow (stage 0-4)
  stats      number cards that count up (show / reveal)
  ask        the funding ask and use of funds
  end        closing card
Captions of what is being said run in the speech bubble (karaoke style), for muted viewing.
"""
import json, math, os, re, subprocess, sys, tempfile
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import earth_buddy as eb  # noqa: E402
import series_styles as ss  # noqa: E402
from earth_buddy import W, H, FPS, FB, FS, FR, FX, font, wrap, fit_lines, ease, pop, indian  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
THEME = eb.THEMES["forest"]
INK, GREEN, GOLD, DARK, MUTED, RED = (20, 83, 45), (21, 128, 61), (234, 179, 8), (17, 24, 39), (90, 105, 95), (220, 38, 38)
GAP = 0.35
PW, PH, PX, PY = 960, 1240, 60, 300          # main panel size and place
CLIP_FPS = 15


# ---------------------------------------------------------------- small helpers

def norm(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def key_time(words, keys, last=False):
    """Start time of the first (or last) spoken word that starts with one of `keys`; None if not said."""
    if not keys:
        return None
    ks = [norm(k) for k in (keys if isinstance(keys, list) else [keys]) if norm(k)]
    hits = [s for s, e, w in words if any(norm(w).startswith(k) for k in ks)]
    return (hits[-1] if last else hits[0]) if hits else None


def shown(local, t0, d=0.35):
    """0..1 appearance after time t0 (always 1 if t0 is None)."""
    return 1.0 if t0 is None else ease((local - t0) / d)


def merge_letters(words):
    """edge-tts says "S I I C" letter by letter; show it as one word "SIIC" in captions."""
    out = []
    for s, e, w in words:
        letter = re.fullmatch(r"[A-Z]\.?", w) is not None
        if letter and out and out[-1][3]:
            out[-1] = [out[-1][0], e, out[-1][2] + w.strip("."), True]
        else:
            out.append([s, e, w.strip(".") if letter else w, letter])
    return [(s, e, w) for s, e, w, _ in out]


def text(d, xy, s, size, fill, path=FB, anchor="mm"):
    d.text(xy, s, font=font(path, size), fill=fill, anchor=anchor)


@lru_cache(maxsize=64)
def card(w, h, radius=44, fill=(255, 255, 255)):
    c = eb.white_card(w, h, radius)
    if fill != (255, 255, 255):
        ImageDraw.Draw(c).rounded_rectangle((0, 0, w - 1, h - 1), radius, fill=fill)
    return c


def paste_scaled(c, im, cx, cy, s, alpha=1.0):
    if s <= 0.02 or alpha <= 0.02:
        return
    if abs(s - 1) > 0.01:
        im = im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))), Image.BICUBIC)
    if alpha < 0.99:
        im = im.copy()
        im.putalpha(im.getchannel("A").point(lambda v: int(v * alpha)))
    c.alpha_composite(im, (int(cx - im.width / 2), int(cy - im.height / 2)))


def logo_crop(path, h):
    kv = Image.open(path).convert("RGB")
    gray = kv.convert("L").point(lambda v: 255 if v < 235 else 0)
    kv = kv.crop(gray.getbbox() or (0, 0, kv.width, kv.height))
    return kv.resize((int(kv.width * h / kv.height), h), Image.LANCZOS).convert("RGBA")


# ---------------------------------------------------------------- sprites (drawn once)

@lru_cache(maxsize=None)
def sprite(kind):
    if kind == "fridge":
        im = Image.new("RGBA", (260, 540), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
        d.rounded_rectangle((10, 10, 250, 530), 26, fill=(226, 232, 240), outline=DARK, width=7)
        d.line((10, 200, 250, 200), fill=DARK, width=6)
        d.rounded_rectangle((205, 80, 222, 160), 8, fill=(148, 163, 184))
        d.rounded_rectangle((205, 240, 222, 360), 8, fill=(148, 163, 184))
        d.line((60, 400, 110, 430), fill=(148, 163, 184), width=5)       # scratches
        d.line((70, 440, 100, 455), fill=(148, 163, 184), width=4)
        d.rectangle((40, 530, 70, 538), fill=DARK); d.rectangle((190, 530, 220, 538), fill=DARK)
    elif kind == "phone":
        im = Image.new("RGBA", (160, 290), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
        d.rounded_rectangle((5, 5, 155, 285), 24, fill=(31, 41, 55), outline=DARK, width=6)
        d.rounded_rectangle((18, 28, 142, 250), 10, fill=(71, 85, 105))
        for a, b in [((40, 60), (90, 120)), ((90, 120), (70, 200)), ((90, 120), (130, 150)), ((70, 200), (110, 240))]:
            d.line(a + b, fill=(226, 232, 240), width=3)                   # cracked screen
        d.ellipse((70, 258, 90, 278), fill=(71, 85, 105))
    elif kind == "papers":
        im = Image.new("RGBA", (300, 230), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
        for i in range(6):
            y = 200 - i * 32
            x = 10 + (i % 2) * 14
            d.rounded_rectangle((x, y - 30, x + 270, y + 20), 6, fill=(254, 249, 231), outline=DARK, width=4)
            for k in range(3):
                d.line((x + 20, y - 18 + k * 12, x + 200 - k * 30, y - 18 + k * 12), fill=(203, 213, 225), width=3)
        d.line((140, 20, 140, 225), fill=(180, 83, 9), width=6)            # string
    elif kind == "globe":
        im = Image.new("RGBA", (220, 220), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
        d.ellipse((6, 6, 214, 214), fill=(59, 130, 246), outline=DARK, width=6)
        d.polygon([(50, 60), (100, 40), (120, 80), (90, 120), (60, 110)], fill=(34, 197, 94))
        d.polygon([(120, 130), (170, 110), (190, 150), (150, 190), (125, 170)], fill=(34, 197, 94))
        d.ellipse((140, 50, 175, 80), fill=(34, 197, 94))
    elif kind == "coin":
        im = Image.open(ROOT / "data" / "brand" / "karmaverse-k-coin.png").convert("RGBA").resize((240, 240), Image.LANCZOS)
    else:
        raise KeyError(kind)
    return im


def stamp(textv, color):
    f = font(FX, 58)
    tw = int(ImageDraw.Draw(Image.new("RGB", (1, 1))).textlength(textv, font=f))
    im = Image.new("RGBA", (tw + 80, 120), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((5, 5, im.width - 5, im.height - 5), 20, outline=color + (255,), width=9, fill=(255, 255, 255, 230))
    d.text((im.width / 2, im.height / 2 + 2), textv, font=f, fill=color + (255,), anchor="mm")
    return im.rotate(-7, expand=True, resample=Image.BICUBIC)


# ---------------------------------------------------------------- phone and footage

@lru_cache(maxsize=8)
def phone_shell(sw, sh):
    b = 18
    ph = Image.new("RGBA", (sw + 2 * b + 40, sh + 2 * b + 50), (0, 0, 0, 0))
    sh_ = Image.new("RGBA", ph.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh_).rounded_rectangle((20, 30, sw + 2 * b + 20, sh + 2 * b + 30), 60, fill=(0, 0, 0, 90))
    ph = Image.alpha_composite(ph, sh_.filter(ImageFilter.GaussianBlur(16)))
    ImageDraw.Draw(ph).rounded_rectangle((0, 0, sw + 2 * b, sh + 2 * b), 62, fill=(17, 24, 39))
    m = Image.new("L", (sw, sh), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, sw - 1, sh - 1), 44, fill=255)
    return ph, m, b


def in_phone(screen):
    ph, m, b = phone_shell(screen.width, screen.height)
    ph = ph.copy()
    ph.paste(screen, (b, b), m)
    return ph


class Footage:
    """Frames of the current line's footage, decoded once per line."""

    def __init__(self, ffmpeg):
        self.ff, self.key, self.frames = ffmpeg, None, []

    def load(self, key, segs, size):
        if key == self.key:
            return
        sw, sh = size
        frames = []
        for seg in segs:
            if "image" in seg:
                im = Image.open(ROOT / seg["image"] if not os.path.isabs(seg["image"]) else seg["image"]).convert("RGB")
                im = im.resize((sw, int(im.height * sw / im.width)), Image.LANCZOS)
                canvas = Image.new("RGB", (sw, sh), (255, 255, 255))
                canvas.paste(im.crop((0, 0, sw, min(sh, im.height))), (0, 0))
                frames += [self._private(canvas, seg)] * int(seg.get("secs", 3) * CLIP_FPS)
                continue
            src = seg["file"] if os.path.isabs(seg["file"]) else str(ROOT / seg["file"])
            vf = f"crop={':'.join(str(v) for v in seg['crop'])}," if seg.get("crop") else ""
            if "at" in seg:   # a single frame held still (for screens that scroll past private details)
                cmd = ["-ss", str(seg["at"]), "-i", src, "-frames:v", "1", "-vf", f"{vf}scale={sw}:{sh}"]
            else:
                cmd = ["-ss", str(seg["from"]), "-t", str(seg["to"] - seg["from"]), "-i", src, "-vf", f"{vf}fps={CLIP_FPS},scale={sw}:{sh}"]
            raw = subprocess.run([self.ff, "-v", "error", *cmd, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], check=True, capture_output=True).stdout
            n = sw * sh * 3
            got = [self._private(Image.frombytes("RGB", (sw, sh), raw[i:i + n]), seg) for i in range(0, len(raw) - n + 1, n)]
            if "at" in seg and got:
                got = got[:1] * int(seg.get("secs", 2.5) * CLIP_FPS)
            frames += got
        self.key, self.frames = key, frames or [Image.new("RGB", (sw, sh), (255, 255, 255))]

    @staticmethod
    def _private(im, seg):
        """Blurs boxes given as fractions of the frame [x0, y0, x1, y1] (names, phone numbers, addresses)."""
        for x0, y0, x1, y1 in seg.get("blur", []):
            box = (int(x0 * im.width), int(y0 * im.height), int(x1 * im.width), int(y1 * im.height))
            im.paste(im.crop(box).filter(ImageFilter.GaussianBlur(14)), box[:2])
        return im

    def frame(self, local, dur):
        length = len(self.frames) / CLIP_FPS
        speed = max(1.0, length / max(0.5, dur))          # speed up a little if the footage is longer than the line
        return self.frames[min(len(self.frames) - 1, int(max(0.0, local) * speed * CLIP_FPS))]


# ---------------------------------------------------------------- visuals

def v_corner(c, v, local, words, A):
    stage = v.get("stage", "intro")
    d = ImageDraw.Draw(c)
    box = card(PW, 980)
    c.alpha_composite(box, (0, 120))
    head = v.get("head", "")
    if head:
        f, lines = fit_lines(d, head, FB, 64, PW - 120, 2, min_size=44)
        for i, ln in enumerate(lines):
            d.text((PW // 2, 190 + i * (f.size + 10)), ln, font=f, fill=INK, anchor="ma")
    floor = 950
    d.line((60, floor + 8, PW - 60, floor + 8), fill=(203, 213, 225), width=6)
    items = [("fridge", 230, "fridge"), ("phone", 500, "phone"), ("papers", 735, "newspaper")]
    karma_t = key_time(words, "karma", last=True) if stage == "karma" else None
    fade = 1 - shown(local, karma_t, 0.5) if karma_t is not None else 1.0
    for kind, x, key in items:
        im = sprite(kind)
        t0 = key_time(words, key) if stage == "intro" else None
        s = pop(min(1.0, (local - t0) / 0.4)) if t0 is not None else 1.0
        if t0 is not None and local < t0:
            continue
        dim = 0.5 if stage == "paid" else 1.0
        if stage == "paid":                      # shrink the clutter so the payoff has room above it
            s *= 0.5
        paste_scaled(c, im, x, floor - im.height * s / 2, s, alpha=dim * fade)
    if stage == "paid":
        for kind, key, cx in (("coin", "paid", 300), ("globe", "planet", 660)):
            t0 = key_time(words, key)
            if t0 is None or local >= t0:
                s = pop(min(1.0, (local - (t0 or 0)) / 0.45))
                paste_scaled(c, sprite(kind), cx, 450 + 10 * math.sin(local * 3), s)
        t1 = key_time(words, "paid")
        if t1 is not None and local >= t1:
            text(d, (300, 610), "+ Karma Coins", 44, GREEN)
        t2 = key_time(words, "planet")
        if t2 is not None and local >= t2:
            text(d, (660, 610), "+ A greener planet", 44, (37, 99, 235))
    if stage == "stuck":
        for key, label, col, xy in (("sits", "SITS AT HOME", (180, 83, 9), (300, 470)), ("thrown", "THROWN AWAY", RED, (640, 600))):
            t0 = key_time(words, key)
            if t0 is not None and local >= t0:
                st = stamp(label, col)
                s = 1.6 - 0.6 * ease((local - t0) / 0.25)
                paste_scaled(c, st, xy[0], xy[1], s)
    if stage == "karma":
        t0 = key_time(words, "clutter")
        if t0 is not None and local >= t0 and fade > 0.02:
            paste_scaled(c, stamp("CLUTTER?", RED), PW // 2, 520, 1.0, alpha=fade)
        if karma_t is not None and local >= karma_t:
            s = pop(min(1.0, (local - karma_t) / 0.5)) * 1.7
            paste_scaled(c, sprite("coin"), PW // 2, 700, s)
            text(d, (PW // 2, 980), "See karma.", 72, GREEN, FX)


def v_brand(c, v, local, words, A):
    s = pop(min(1.0, local / 0.5))
    c.alpha_composite(card(PW, 760), (0, 200))
    paste_scaled(c, A["kv_logo"], PW // 2, 520, s)
    d = ImageDraw.Draw(c)
    if local > 0.5:
        text(d, (PW // 2, 820), v.get("tag", "Earn • Impact • Elevate"), 54, GREEN, FS)


def v_badges(c, v, local, words, A):
    d = ImageDraw.Draw(c)
    c.alpha_composite(card(PW, 330), (0, 0))
    paste_scaled(c, A["r3_logo"], 170, 165, 1.0)
    text(d, (330, 120), "3R ZeroWaste", 70, INK, FX, "lm")
    text(d, (330, 205), "The team behind KarmaVerse", 40, MUTED, FS, "lm")
    for i, b in enumerate(v["badges"]):
        t0 = key_time(words, b.get("key"))
        if t0 is not None and local < t0:
            continue
        a = shown(local, t0, 0.4)
        y = 400 + i * 270 + int(60 * (1 - a))
        bc = card(PW, 230)
        c.alpha_composite(bc, (0, y))
        d.ellipse((50, y + 55, 170, y + 175), fill=GOLD)
        if b["icon"] == "check":                 # the bold font has no tick glyph
            d.line([(82, y + 117), (103, y + 140), (140, y + 92)], fill=DARK, width=12, joint="curve")
        else:
            text(d, (110, y + 115), b["icon"], 54 if len(b["icon"]) < 3 else 44, DARK, FX)
        text(d, (210, y + 80), b["big"], 60, INK, FX, "lm")
        text(d, (210, y + 155), b["small"], 40, MUTED, FS, "lm")


def v_counter(c, v, local, words, A):
    d = ImageDraw.Draw(c)
    c.alpha_composite(card(PW, 900), (0, 140))
    text(d, (PW // 2, 260), v.get("pre", ""), 52, MUTED, FS)
    t0 = key_time(words, v.get("key")) or 0.3
    n = v["value"] * ease((local - t0) / 1.6) if local > t0 else 0
    text(d, (PW // 2, 470), indian(n), 170, (180, 83, 9), FX)
    text(d, (PW // 2, 640), v["label"], 66, INK, FB)
    text(d, (PW // 2, 730), v.get("label2", ""), 52, MUTED, FS)
    if v.get("source"):
        text(d, (PW // 2, 960), v["source"], 30, MUTED, FR)


def v_ring(c, v, local, words, A):
    d = ImageDraw.Draw(c)
    c.alpha_composite(card(PW, 900), (0, 140))
    text(d, (PW // 2, 230), v.get("pre", ""), 46, MUTED, FS)
    t0 = key_time(words, v.get("key")) or 0.2
    frac = v["value"] / 100 * ease((local - t0) / 1.2) if local > t0 else 0
    cx, cy, r = PW // 2, 590, 260
    d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=(220, 252, 231), width=70)
    if frac > 0:
        d.arc((cx - r, cy - r, cx + r, cy + r), -90, -90 + 360 * frac, fill=RED, width=70)
    text(d, (cx, cy - 10), f"~{round(frac * 100)}%", 140, RED, FX)
    text(d, (PW // 2, 950), v["label"], 62, INK, FB)
    if v.get("source"):
        text(d, (PW // 2, 1010), v["source"], 30, MUTED, FR)


def v_questions(c, v, local, words, A):
    d = ImageDraw.Draw(c)
    text(d, (PW // 2, 90), v.get("head", ""), 62, INK, FX)
    cols = [(37, 99, 235), (180, 83, 9), (124, 58, 237)]
    for i, q in enumerate(v["items"]):
        t0 = key_time(words, q.get("key"))
        if t0 is None or local < t0:
            continue
        a = ease((local - t0) / 0.35)
        x = int(-120 * (1 - a))
        y = 200 + i * 300
        c.alpha_composite(card(PW, 250), (x, y))
        d.ellipse((x + 50, y + 55, x + 190, y + 195), fill=cols[i])
        text(d, (x + 120, y + 122), "?", 96, (255, 255, 255), FX)
        text(d, (x + 240, y + 125), q["text"], 60, DARK, FB, "lm")


CHIPS = ["Choose items", "Book a slot", "Live tracking", "Agent verifies", "Wallet", "Quiz & rewards"]


def v_demo(c, v, local, words, A, footage, dur):
    d = ImageDraw.Draw(c)
    f, lines = fit_lines(d, v.get("title", ""), FX, 60, PW - 40, 2, min_size=44)
    for i, ln in enumerate(lines):
        d.text((PW // 2, 10 + i * (f.size + 6)), ln, font=f, fill=INK, anchor="ma")
    # Feature chips in two rows of three; the one being shown is filled.
    fc = font(FB, 34)
    for i, label in enumerate(CHIPS):
        row, col = divmod(i, 3)
        cw = 300
        x0 = (PW - 3 * cw - 2 * 16) // 2 + col * (cw + 16)
        y0 = 160 + row * 74
        on = i == v.get("chip", -1)
        d.rounded_rectangle((x0, y0, x0 + cw, y0 + 60), 30, fill=GREEN if on else (255, 255, 255), outline=GREEN, width=4)
        d.text((x0 + cw / 2, y0 + 31), label, font=fc, fill=(255, 255, 255) if on else GREEN, anchor="mm")
    split = v.get("split")
    size = (820, 764) if split else (380, 842)
    footage.load(v["id"], v["segs"], size)
    fr = footage.frame(local, dur)
    if split:
        w, h = size[0] + 40, size[1] + 100
        c.alpha_composite(card(w, h, 36), ((PW - w) // 2, 330))
        text(d, ((PW - w) // 2 + 20 + size[0] * 0.28, 372), "Customer app", 34, MUTED, FB)
        text(d, ((PW - w) // 2 + 20 + size[0] * 0.78, 372), "Agent app", 34, MUTED, FB)
        c.paste(fr, ((PW - w) // 2 + 20, 410))
    else:
        ph = in_phone(fr)
        c.alpha_composite(ph, ((PW - ph.width) // 2 + 20, 330))


def v_model(c, v, local, words, A):
    d = ImageDraw.Draw(c)
    stage = v.get("stage", 0)
    text(d, (PW // 2, 40), v.get("head", "The waste itself is the value"), 58, INK, FX)

    def node(cx, cy, w, h, label, sub=None, hi=False, num=None, fill=(255, 255, 255)):
        bc = card(w, h, 34, fill)
        c.alpha_composite(bc, (cx - w // 2, cy - h // 2))
        if hi:
            d.rounded_rectangle((cx - w // 2 - 6, cy - h // 2 - 6, cx + w // 2 + 6, cy + h // 2 + 6), 38, outline=GOLD, width=10)
        ink = (255, 255, 255) if fill != (255, 255, 255) else INK
        if sub:
            text(d, (cx, cy - 22), label, 44, ink, FB)
            text(d, (cx, cy + 30), sub, 30, ink if fill != (255, 255, 255) else MUTED, FS)
        else:
            text(d, (cx, cy), label, 46, ink, FB)
        if num:
            d.ellipse((cx - w // 2 - 26, cy - h // 2 - 26, cx - w // 2 + 40, cy - h // 2 + 40), fill=GOLD)
            text(d, (cx - w // 2 + 7, cy - h // 2 + 7), str(num), 40, DARK, FX)

    def arrow(x0, y0, x1, y1, prog=1.0, t=0.0):
        if prog <= 0:
            return
        xe, ye = x0 + (x1 - x0) * prog, y0 + (y1 - y0) * prog
        d.line((x0, y0, xe, ye), fill=GREEN, width=10)
        if prog >= 0.98:
            ang = math.atan2(y1 - y0, x1 - x0)
            pts = [(x1, y1), (x1 - 34 * math.cos(ang - 0.5), y1 - 34 * math.sin(ang - 0.5)), (x1 - 34 * math.cos(ang + 0.5), y1 - 34 * math.sin(ang + 0.5))]
            d.polygon(pts, fill=GREEN)
            k = (t * 0.8) % 1.0                                  # a dot travelling along the arrow
            d.ellipse((x0 + (x1 - x0) * k - 11, y0 + (y1 - y0) * k - 11, x0 + (x1 - x0) * k + 11, y0 + (y1 - y0) * k + 11), fill=GOLD)

    g = local if stage == 0 else 9.0
    a1, a2 = ease((g - 0.4) / 0.6), ease((g - 1.2) / 0.6)
    node(PW // 2, 190, 560, 110, "Homes", "old items, e-waste, scrap")
    arrow(PW // 2, 250, PW // 2, 330, a1, local)
    if a1 > 0.9 or stage > 0:
        node(PW // 2, 400, 560, 120, "KarmaVerse app", "pickups, coins, rewards", fill=GREEN)
    arrow(PW // 2, 465, PW // 2, 545, a2, local)
    if a2 > 0.9 or stage > 0:
        node(PW // 2, 615, 560, 120, "3R ZeroWaste", "sorts & processes", fill=INK)
    if stage >= 1:
        arrow(PW // 2 - 120, 680, 250, 790, ease(local / 0.5) if stage == 1 else 1, local)
        node(250, 870, 420, 150, "Recyclers", "core revenue today", hi=stage == 1, num=1)
    if stage >= 2:
        arrow(PW // 2 + 120, 680, 710, 790, ease(local / 0.5) if stage == 2 else 1, local)
        node(710, 870, 420, 150, "B2B products", "for business buyers", hi=stage == 2, num=2)
    if stage >= 3:
        a = ease(local / 0.5) if stage == 3 else 1
        node(PW // 2, 1100 + int(40 * (1 - a)), 720, 130, "Brand CSR partnerships", "awareness & campaigns", hi=stage == 3, num=3)
    if stage >= 4:
        a = ease(local / 0.5)
        d.rounded_rectangle((60, 1185, PW - 60, 1240), 28, fill=GOLD)
        if a > 0.3:
            text(d, (PW // 2, 1213), "More users → more supply → more revenue", 36, DARK, FB)


def v_stats(c, v, local, words, A):
    d = ImageDraw.Draw(c)
    text(d, (PW // 2, 60), v.get("head", ""), 58, INK, FX)
    for i, item in enumerate(v["cards"]):
        if i not in v.get("show", []) and str(i) not in v.get("reveal", {}):
            continue
        key = v.get("reveal", {}).get(str(i))
        t0 = key_time(words, key) if key else None
        if key and t0 is None:
            t0 = 0.0
        if t0 is not None and local < t0:
            continue
        col, row = i % 2, i // 2
        x, y = col * (PW // 2 + 10), 150 + row * 520
        w, h = PW // 2 - 10, 490
        a = shown(local, t0, 0.35)
        c.alpha_composite(card(w, h, 40), (x, y + int(50 * (1 - a))))
        k = ease((local - t0) / 1.2) if t0 is not None else 1.0
        val = item["value"] * k
        s = (f"{val:.1f}" if isinstance(item["value"], float) else indian(val)) + item.get("unit", "")
        text(d, (x + w // 2, y + 190), s, 112 if len(s) < 6 else 92, GREEN if i % 3 else (180, 83, 9), FX)
        for j, ln in enumerate(wrap(d, item["label"], font(FS, 40), w - 60)[:3]):
            text(d, (x + w // 2, y + 320 + j * 50), ln, 40, MUTED, FS)


def v_ask(c, v, local, words, A):
    d = ImageDraw.Draw(c)
    c.alpha_composite(card(PW, 420, 44, INK), (0, 0))
    text(d, (PW // 2, 90), "We're raising", 52, (220, 252, 231), FS)
    s = pop(min(1.0, local / 0.5))
    big = Image.new("RGBA", (PW, 220), (0, 0, 0, 0))
    ImageDraw.Draw(big).text((PW // 2, 110), v.get("amount", "₹5 Crore"), font=font(FX, 170), fill=GOLD, anchor="mm")
    paste_scaled(c, big, PW // 2, 260, s)
    text(d, (PW // 2, 480), "to grow KarmaVerse", 50, INK, FB)
    for i, u in enumerate(v["uses"]):
        t0 = key_time(words, u.get("key"))
        if t0 is not None and local < t0:
            continue
        a = shown(local, t0, 0.35)
        y = 570 + i * 220 + int(50 * (1 - a))
        c.alpha_composite(card(PW, 190, 36), (0, y))
        d.ellipse((40, y + 40, 150, y + 150), fill=GOLD)
        text(d, (95, y + 95), str(i + 1), 60, DARK, FX)
        text(d, (190, y + 70), u["big"], 52, INK, FB, "lm")
        text(d, (190, y + 132), u["small"], 36, MUTED, FS, "lm")


def v_end(c, v, local, words, A):
    d = ImageDraw.Draw(c)
    c.alpha_composite(card(PW, 1180), (0, 20))
    paste_scaled(c, A["kv_logo_big"], PW // 2, 260, pop(min(1.0, local / 0.5)))
    # "Earn · Impact · Elevate", centred as one line; each word pops in when it is said.
    fw = font(FX, 76)
    trio = ["Earn", "Impact", "Elevate"]
    dot = "  ·  "
    widths = [d.textlength(w_, font=fw) for w_ in trio]
    x = (PW - (sum(widths) + 2 * d.textlength(dot, font=fw))) / 2
    for i, w_ in enumerate(trio):
        t0 = key_time(words, w_, last=True)
        if t0 is None or local >= t0:
            s = pop(min(1.0, (local - (t0 or 0)) / 0.4))
            im = Image.new("RGBA", (int(widths[i]) + 20, 120), (0, 0, 0, 0))
            ImageDraw.Draw(im).text((im.width / 2, 60), w_, font=fw, fill=[GREEN, (180, 83, 9), INK][i] + (255,), anchor="mm")
            paste_scaled(c, im, x + widths[i] / 2, 540, s)
            if i < 2:
                d.text((x + widths[i], 540), dot, font=fw, fill=GOLD, anchor="lm")
        x += widths[i] + d.textlength(dot, font=fw)
    if local > 1.0:
        a = shown(local, 1.0, 0.4)
        y = 680 + int(30 * (1 - a))
        d.rounded_rectangle((100, y, PW - 100, y + 120), 60, fill=GREEN)
        text(d, (PW // 2, y + 60), v.get("button", "Search “KarmaVerse” on Google Play"), 42, (255, 255, 255), FB)
        text(d, (PW // 2, y + 190), v.get("site", "karmaverse.earth"), 56, GREEN, FX)
        if v.get("contact"):
            text(d, (PW // 2, y + 260), v["contact"], 40, MUTED, FS)
        paste_scaled(c, A["r3_small"], 200, y + 380, 1.0)
        text(d, (270, y + 360), "A 3R ZeroWaste initiative", 40, INK, FB, "lm")
        text(d, (270, y + 410), "SIIC IIT Kanpur · DPIIT-recognised", 32, MUTED, FS, "lm")


# ---------------------------------------------------------------- captions and frame parts

def chunks(words, size=8):
    out = [words[i:i + size] for i in range(0, len(words), size)]
    if len(out) > 1 and len(out[-1]) < 3:
        tail = out.pop()
        out[-1] = out[-1] + tail
    return out


def caption(frame, words, local):
    """Karaoke caption beside Earth Buddy: words said so far are dark, the current one green."""
    if not words:
        return
    cs = chunks(words)
    ci = max([i for i, ch in enumerate(cs) if ch[0][0] <= local + 0.05] or [0])
    ch = cs[ci]
    bw, x0, y0 = 720, 330, 1585
    f, fb = font(FS, 46), font(FB, 46)
    d0 = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    lines, cur, cw = [], [], 0
    for wd in ch:
        ww = d0.textlength(wd[2] + " ", font=fb)
        if cur and cw + ww > bw - 70:
            lines.append(cur); cur, cw = [], 0
        cur.append(wd); cw += ww
    if cur:
        lines.append(cur)
    lines = lines[:4]
    bh = 40 + 62 * len(lines)
    d = ImageDraw.Draw(frame)
    d.rounded_rectangle((x0, y0, x0 + bw, y0 + bh), 34, fill=(255, 255, 255), outline=INK, width=5)
    d.polygon([(x0 + 2, y0 + 50), (x0 - 40, y0 + 80), (x0 + 2, y0 + 100)], fill=(255, 255, 255))
    d.line([(x0, y0 + 50), (x0 - 40, y0 + 80), (x0, y0 + 100)], fill=INK, width=5)
    for i, ln in enumerate(lines):
        x = x0 + 35
        for s, e, w in ln:
            now = s <= local < e + 0.05
            said = s <= local
            d.text((x, y0 + 22 + i * 62), w, font=fb if now else f, fill=GREEN if now else (DARK if said else (156, 163, 175)))
            x += d.textlength(w + " ", font=fb)


def section_bar(frame, names, sec_starts, total, tt, current):
    d = ImageDraw.Draw(frame)
    n, gap, x0, tw = len(names), 10, 60, W - 120
    seg = (tw - gap * (n - 1)) / n
    for i in range(n):
        a = sec_starts[i]
        b = sec_starts[i + 1] if i + 1 < n else total
        fr = max(0.0, min(1.0, (tt - a) / max(0.1, b - a)))
        x = x0 + i * (seg + gap)
        d.rounded_rectangle((x, 18, x + seg, 28), 5, fill=(187, 222, 199))
        if fr > 0:
            d.rounded_rectangle((x, 18, x + max(10, seg * fr), 28), 5, fill=THEME["accent"])
    label = f"{current + 1:02d}  ·  {names[current].upper()}"
    f = font(FB, 36)
    tw_ = d.textlength(label, font=f)
    d.rounded_rectangle((W / 2 - tw_ / 2 - 30, 238, W / 2 + tw_ / 2 + 30, 290), 26, fill=GREEN)
    d.text((W / 2, 264), label, font=f, fill=(255, 255, 255), anchor="mm")


# ---------------------------------------------------------------- render

VISUALS = {"corner": v_corner, "brand": v_brand, "badges": v_badges, "counter": v_counter, "ring": v_ring,
           "questions": v_questions, "model": v_model, "stats": v_stats, "ask": v_ask, "end": v_end}


def render(spec, stills_dir=None):
    """Renders the video; with `stills_dir`, saves one PNG per line (mid-line) instead, for a quick check."""
    ff = spec.get("ffmpeg") or str(ROOT / "node_modules" / "ffmpeg-static" / "ffmpeg.exe")
    work = tempfile.mkdtemp(prefix="pitch-")
    lines = spec["lines"]
    voice = spec.get("voice", "en-IN-NeerjaExpressiveNeural")

    clips = []
    cache = ROOT / "data" / "pitch" / ".voice-cache"
    cache.mkdir(parents=True, exist_ok=True)
    for i, ln in enumerate(lines):
        rate, pitch = spec.get("rate", "+0%"), spec.get("pitch", "+0Hz")
        import hashlib
        h = hashlib.sha1(f"{voice}|{rate}|{pitch}|{ln['say']}".encode()).hexdigest()[:16]
        mp3, wj = str(cache / f"{h}.mp3"), cache / f"{h}.json"
        if wj.exists() and os.path.exists(mp3):
            words = [tuple(w) for w in json.loads(wj.read_text(encoding="utf-8"))]
        else:
            words = eb.tts_words(ln["say"], mp3, voice, rate, pitch)
            wj.write_text(json.dumps(words), encoding="utf-8")
        samples = eb.decode(ff, mp3)
        clips.append((mp3, len(samples) / 16000, eb.levels(samples), merge_letters(words)))
        print(f"voice {i + 1}/{len(lines)}: {clips[-1][1]:.1f}s", flush=True)

    holds = [float(ln.get("hold", 0)) for ln in lines]
    voice_wav = os.path.join(work, "voice.wav")
    inputs, filt = [], []
    for i, cl in enumerate(clips):
        inputs += ["-i", cl[0]]
        filt.append(f"[{i}:a]aresample=48000,apad=pad_dur={GAP + holds[i]}[a{i}]")
    filt.append("".join(f"[a{i}]" for i in range(len(clips))) + f"concat=n={len(clips)}:v=0:a=1[v]")
    subprocess.run([ff, "-y", "-loglevel", "error", *inputs, "-filter_complex", ";".join(filt), "-map", "[v]", voice_wav], check=True)

    lead = 0.6
    starts, t = [], lead
    for i, cl in enumerate(clips):
        starts.append(t)
        t += cl[1] + GAP + holds[i]
    total = t + 0.4
    names = spec["sections"]
    sec_starts = [next(starts[i] for i, ln in enumerate(lines) if ln["section"] == s) for s in range(len(names))]
    group_start = []
    for i, ln in enumerate(lines):
        g = ln["visual"].get("group")
        group_start.append(group_start[i - 1] if i and g and lines[i - 1]["visual"].get("group") == g else i)
    print(f"total {total:.1f}s", flush=True)

    bg = eb.background(THEME, 1)
    bar = eb.logo_bar(spec)
    bg.paste(bar, (60, 50), bar)
    falling = eb.make_leaves(4)
    mascot = eb.cutout(spec["mascot"])
    ms = 0.27
    mw, mh = int(mascot.width * ms), int(mascot.height * ms)
    rest = mascot.resize((mw, mh), Image.BICUBIC)
    mouth = tuple(spec.get("mouth", [448, 568, 664, 642]))
    mx, my = 15, H - mh - 15
    kv_full = logo_crop(spec["logo"], 260)
    A = {
        "kv_logo": kv_full if kv_full.width <= PW - 100 else kv_full.resize((PW - 100, int(260 * (PW - 100) / kv_full.width))),
        "kv_logo_big": kv_full if kv_full.width <= PW - 100 else kv_full.resize((PW - 100, int(260 * (PW - 100) / kv_full.width))),
        "r3_logo": Image.open(spec["partnerLogo"]).convert("RGBA").resize((230, 230), Image.LANCZOS),
        "r3_small": Image.open(spec["partnerLogo"]).convert("RGBA").resize((110, 110), Image.LANCZOS),
    }
    footage = Footage(ff)

    silent = os.path.join(work, "video.mp4")
    nframes = int(total * FPS)
    if stills_dir:
        os.makedirs(stills_dir, exist_ok=True)
        # Late in each line, so keyword pop-ins have happened.
        todo = [int((starts[i] + clips[i][1] * 0.85) * FPS) for i in range(len(lines))]
        proc = None
    else:
        todo = range(nframes)
        proc = subprocess.Popen([ff, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                                 "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-g", "60", silent], stdin=subprocess.PIPE)
    for fi in todo:
        tt = fi / FPS
        li = max([i for i, s in enumerate(starts) if s <= tt] or [0])
        ln, cl = lines[li], clips[li]
        local, dur, words = tt - starts[li], cl[1], cl[3]
        v = ln["visual"]
        frame = bg.copy()
        eb.leaves(frame, THEME, falling, tt)
        section_bar(frame, names, sec_starts, total, tt, ln["section"])

        panel = Image.new("RGBA", (PW, PH), (0, 0, 0, 0))
        if v["type"] == "demo":
            v_demo(panel, v, local, words, A, footage, dur)
        else:
            VISUALS[v["type"]](panel, v, local, words, A)
        glocal = tt - starts[group_start[li]]
        a = ease(glocal / 0.4) if tt > lead else 1.0
        if a < 0.999:
            panel.putalpha(panel.getchannel("A").point(lambda x: int(x * a)))
        frame.paste(panel, (PX, PY + int(70 * (1 - a))), panel)
        if v["type"] == "end":
            ss.confetti(frame, local - 0.3, origin=(W // 2, 600))
        if v["type"] == "corner" and v.get("stage") == "karma":
            kt = key_time(words, "karma", last=True)
            if kt is not None and local > kt:
                ss.sparkles(frame, local - kt, W // 2, PY + 700, spread=330, flat=0.5)

        lv = cl[2]
        k = int(local * FPS)
        level = lv[k] if 0 <= k < len(lv) else 0.0
        m = rest if level < 0.06 else eb.open_mouth(mascot, level, mouth).resize((mw, mh), Image.BICUBIC)
        frame.paste(m, (mx, my + int(6 * math.sin(tt * 2.2)) + int((1 - ease(tt / 0.6)) * 300)), m)
        caption(frame, words, local)

        if proc is None:
            frame.save(os.path.join(stills_dir, f"line{li + 1:02d}.png"))
            continue
        proc.stdin.write(frame.tobytes())
        if fi % 300 == 0:
            print(f"frame {fi}/{nframes}", flush=True)
    if proc is None:
        print(f"stills saved to {stills_dir}", flush=True)
        return
    proc.stdin.close()
    if proc.wait() != 0:
        raise SystemExit("ffmpeg failed while encoding frames")

    out = str(ROOT / spec["out"]) if not os.path.isabs(spec["out"]) else spec["out"]
    st = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo"
    lead_ms = int(lead * 1000)
    ins = ["-i", silent, "-i", voice_wav]
    filt = [f"[1:a]{st},adelay={lead_ms}|{lead_ms},apad[v]"]
    music = spec.get("music")
    if music and os.path.exists(ROOT / music if not os.path.isabs(music) else music):
        ins += ["-stream_loop", "-1", "-i", str(ROOT / music) if not os.path.isabs(music) else music]
        filt.append(f"[2:a]{st},volume={spec.get('musicVolume', 0.08)},afade=t=in:d=1.5,afade=t=out:st={total - 3:.2f}:d=3[m]")
        filt.append(f"[v][m]amix=inputs=2:duration=first:normalize=0,atrim=0:{total:.2f},loudnorm=I=-15:TP=-1.5:LRA=11[a]")
    else:
        filt.append(f"[v]atrim=0:{total:.2f},loudnorm=I=-15:TP=-1.5:LRA=11[a]")
    subprocess.run([ff, "-y", "-loglevel", "error", *ins, "-filter_complex", ";".join(filt), "-map", "0:v", "-map", "[a]",
                    "-c:v", "copy", "-c:a", "aac", "-ar", "48000", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out], check=True)
    print(json.dumps({"file": out, "durationSec": round(total, 1)}), flush=True)


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as f:
        sp = json.load(f)
    for k in ("logo", "partnerLogo", "mascot"):
        if not os.path.isabs(sp[k]):
            sp[k] = str(ROOT / sp[k])
    render(sp, sys.argv[3] if len(sys.argv) > 3 and sys.argv[2] == "--stills" else None)
