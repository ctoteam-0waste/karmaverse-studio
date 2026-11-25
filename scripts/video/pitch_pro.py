"""Professional investor pitch video, 16:9 (1920x1080), clean corporate look.

Usage: python scripts/video/pitch_pro.py data/pitch/karmaverse-pitch.json [--stills DIR]

Uses the same spec as pitch_video.py (lines, visuals, footage), but draws it as a
corporate explainer: no mascot, off-white and deep-green layout, big type, line
icons, app footage in a phone, and plain subtitles at the bottom. The voice and
music settings can be overridden with "pro": {"voice", "rate", "pitch", "out", "musicVolume"}.
"""
import hashlib, json, math, os, re, subprocess, sys, tempfile
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import earth_buddy as eb  # noqa: E402
from earth_buddy import FB, FS, FR, FX, font, wrap, ease, indian  # noqa: E402
from pitch_video import Footage, key_time, merge_letters, logo_crop  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
W, H, FPS = 1920, 1080, 30
GAP = 0.38
BG = (247, 249, 248)
DEEP, GREEN, MINT, GOLD = (5, 46, 22), (21, 128, 61), (220, 252, 231), (202, 138, 4)
INK, MUTED, LINE, RED = (17, 24, 39), (100, 116, 108), (222, 229, 225), (185, 28, 28)
LX, RX = 130, 1000                 # left text column, right visual column
TOP, BOTTOM = 150, 900             # content band


def tx(d, xy, s, size, fill, path=FB, anchor="la"):
    d.text(xy, s, font=font(path, size), fill=fill, anchor=anchor)


def appear(local, t0, d=0.45):
    return 1.0 if t0 is None else ease((local - t0) / d)


def para(d, xy, s, size, fill, width, path=FB, gap=1.18, max_lines=4):
    f = font(path, size)
    y = xy[1]
    for ln in wrap(d, s, f, width)[:max_lines]:
        d.text((xy[0], y), ln, font=f, fill=fill)
        y += int(size * gap)
    return y


@lru_cache(maxsize=64)
def panel(w, h, radius=28, fill=(255, 255, 255), shadow=True):
    im = Image.new("RGBA", (w + 60, h + 60), (0, 0, 0, 0))
    if shadow:
        sh = Image.new("RGBA", im.size, (0, 0, 0, 0))
        ImageDraw.Draw(sh).rounded_rectangle((30, 38, w + 30, h + 38), radius, fill=(15, 40, 25, 34))
        im = Image.alpha_composite(im, sh.filter(ImageFilter.GaussianBlur(18)))
    ImageDraw.Draw(im).rounded_rectangle((30, 30, w + 30 - 1, h + 30 - 1), radius, fill=fill)
    return im


def put_panel(c, x, y, w, h, **kw):
    c.alpha_composite(panel(w, h, **kw), (x - 30, y - 30))


# ---------------------------------------------------------------- line icons

@lru_cache(maxsize=None)
def icon(kind, size=160, color=GREEN, sw=7):
    s = 4  # draw big, scale down for smooth lines
    S = size * s
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    k = S / 200
    L = sw * s

    def R(x0, y0, x1, y1, r=10):
        d.rounded_rectangle((x0 * k, y0 * k, x1 * k, y1 * k), r * k, outline=color, width=L)

    def Ln(*pts):
        d.line([(x * k, y * k) for x, y in pts], fill=color, width=L, joint="curve")

    def C(cx, cy, r, fill=None):
        d.ellipse(((cx - r) * k, (cy - r) * k, (cx + r) * k, (cy + r) * k), outline=color, width=L, fill=fill)

    if kind == "fridge":
        R(55, 12, 145, 188, 14); Ln((55, 78), (145, 78)); Ln((128, 36), (128, 58)); Ln((128, 96), (128, 132))
    elif kind == "phone":
        R(65, 12, 135, 188, 16); Ln((90, 168), (110, 168)); Ln((80, 50), (102, 88), (88, 112), (118, 140))
    elif kind == "papers":
        R(40, 60, 150, 170, 6); Ln((60, 90), (130, 90)); Ln((60, 115), (130, 115)); Ln((60, 140), (105, 140))
        Ln((60, 40), (170, 40), (170, 150))
    elif kind == "globe":
        C(100, 100, 82); d.arc((60 * k, 18 * k, 140 * k, 182 * k), 0, 360, fill=color, width=L)
        Ln((18, 100), (182, 100)); Ln((32, 58), (168, 58)); Ln((32, 142), (168, 142))
    elif kind == "home":
        Ln((25, 95), (100, 30), (175, 95)); R(45, 85, 155, 180, 6); R(85, 120, 115, 180, 4)
    elif kind == "truck":
        R(15, 60, 120, 145, 8); Ln((120, 85), (160, 85), (185, 115), (185, 145), (120, 145)); C(55, 158, 16, fill=(255, 255, 255, 255)); C(150, 158, 16, fill=(255, 255, 255, 255))
    elif kind == "factory":
        Ln((20, 180), (20, 90), (70, 120), (70, 90), (120, 120), (120, 40), (150, 40), (150, 180), (20, 180)); Ln((40, 150), (60, 150)); Ln((90, 150), (110, 150))
    elif kind == "box":
        Ln((100, 20), (180, 60), (180, 150), (100, 190), (20, 150), (20, 60), (100, 20)); Ln((20, 60), (100, 100), (180, 60)); Ln((100, 100), (100, 190))
    elif kind == "handshake":
        Ln((15, 80), (55, 60), (100, 85), (145, 60), (185, 80)); Ln((55, 60), (40, 130), (85, 160), (115, 160), (160, 130), (145, 60)); Ln((80, 120), (105, 140))
    elif kind == "city":
        R(20, 80, 80, 185, 4); R(80, 30, 140, 185, 4); R(140, 100, 185, 185, 4)
        for y in (60, 95, 130):
            Ln((98, y), (122, y))
    elif kind == "chip":
        R(50, 50, 150, 150, 12); R(78, 78, 122, 122, 6)
        for p in (75, 100, 125):
            Ln((p, 20), (p, 50)); Ln((p, 150), (p, 180)); Ln((20, p), (50, p)); Ln((150, p), (180, p))
    elif kind == "people":
        C(70, 70, 28); C(135, 80, 24); d.arc((20 * k, 110 * k, 120 * k, 220 * k), 180, 360, fill=color, width=L); d.arc((95 * k, 115 * k, 180 * k, 210 * k), 180, 360, fill=color, width=L)
    elif kind == "question":
        C(100, 100, 82); d.text((100 * k, 104 * k), "?", font=font(FB, int(110 * k)), fill=color, anchor="mm")
    elif kind == "check":
        C(100, 100, 82); Ln((60, 102), (90, 132), (142, 74))
    elif kind == "calendar":
        R(25, 40, 175, 180, 12); Ln((25, 80), (175, 80)); Ln((65, 20), (65, 55)); Ln((135, 20), (135, 55))
    elif kind == "award":
        C(100, 80, 55); Ln((70, 125), (55, 190), (100, 165), (145, 190), (130, 125))
    elif kind == "leaf":
        d.chord((30 * k, 30 * k, 190 * k, 190 * k), 180, 360, outline=color, width=L); Ln((30, 110), (110, 190), (190, 110))
    else:
        raise KeyError(kind)
    return im.resize((size, size), Image.LANCZOS)


@lru_cache(maxsize=4)
def coin(size):
    return Image.open(ROOT / "data" / "brand" / "karmaverse-k-coin.png").convert("RGBA").resize((size, size), Image.LANCZOS)


def badge_icon(c, kind, cx, cy, r=62, bg=MINT, color=GREEN):
    d = ImageDraw.Draw(c)
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=bg)
    ic = icon(kind, int(r * 1.15), color, 8)
    c.alpha_composite(ic, (int(cx - ic.width / 2), int(cy - ic.height / 2)))


def eyebrow(d, text_, y=TOP + 10):
    tx(d, (LX, y), text_.upper(), 26, GREEN, FB)
    d.rectangle((LX, y + 44, LX + 70, y + 49), fill=GOLD)


# ---------------------------------------------------------------- visuals (draw on a full-frame RGBA layer)

def v_corner(c, v, local, words, A, sec):
    d = ImageDraw.Draw(c)
    stage = v.get("stage", "intro")
    eyebrow(d, sec)
    heads = {"intro": "Almost every home has that one corner.", "paid": "What if clearing it paid you, and helped the planet too?",
             "stuck": "So it sits at home, or gets thrown out.", "karma": "Don't see clutter. See karma."}
    para(d, (LX, TOP + 90), heads[stage], 66, INK, 760, FX, max_lines=4)
    items = [("fridge", "Old fridge", "fridge"), ("phone", "Dead phone", "phone"), ("papers", "Old newspapers", "newspaper")]
    if stage in ("intro", "stuck"):
        for i, (kind, label, key) in enumerate(items):
            t0 = key_time(words, key) if stage == "intro" else None
            if t0 is not None and local < t0:
                continue
            a = appear(local, t0)
            x, y = RX + i * 280, 330 + int(40 * (1 - a))
            put_panel(c, x, y, 250, 330)
            c.alpha_composite(icon(kind, 150, MUTED if stage == "stuck" else GREEN), (x + 50, y + 50))
            tx(d, (x + 125, y + 260), label, 30, INK, FS, "mm")
        if stage == "stuck":
            for key, label, xy in (("sits", "Sits at home", (RX + 120, 720)), ("thrown", "Thrown out with everything else", (RX + 120, 800))):
                t0 = key_time(words, key)
                if t0 is not None and local < t0:
                    continue
                a = appear(local, t0, 0.3)
                f = font(FB, 34)
                tw = d.textlength(label, font=f)
                x = xy[0] - int(30 * (1 - a))
                d.rounded_rectangle((x, xy[1], x + tw + 90, xy[1] + 62), 31, fill=(254, 226, 226))
                d.ellipse((x + 22, xy[1] + 22, x + 40, xy[1] + 40), fill=RED)
                d.text((x + 58, xy[1] + 31), label, font=f, fill=RED, anchor="lm")
    elif stage == "paid":
        for i, (key, label, sub) in enumerate((("paid", "Karma Coins", "for every pickup"), ("planet", "Greener planet", "less waste in landfill"))):
            t0 = key_time(words, key)
            if t0 is not None and local < t0:
                continue
            a = appear(local, t0)
            x, y = RX + i * 420, 300 + int(40 * (1 - a))
            put_panel(c, x, y, 380, 460)
            if i == 0:
                c.alpha_composite(coin(200), (x + 90, y + 50))
            else:
                c.alpha_composite(icon("globe", 200, GREEN), (x + 90, y + 50))
            tx(d, (x + 190, y + 320), label, 40, INK, FB, "mm")
            tx(d, (x + 190, y + 375), sub, 28, MUTED, FS, "mm")
    elif stage == "karma":
        t0 = key_time(words, "karma", last=True)
        a = appear(local, t0, 0.6)
        if t0 is None or local >= t0:
            s = int(380 * (0.85 + 0.15 * a))
            cc = coin(380).resize((s, s), Image.LANCZOS)
            cc.putalpha(cc.getchannel("A").point(lambda x: int(x * a)))
            c.alpha_composite(cc, (RX + 400 - s // 2, 520 - s // 2))
        else:
            for i, (kind, _, _) in enumerate(items):
                c.alpha_composite(icon(kind, 170, MUTED), (RX + 60 + i * 260, 430))


def v_brand(c, v, local, words, A, sec):
    d = ImageDraw.Draw(c)
    d.rectangle((0, 0, W, H), fill=DEEP + (255,))
    a = ease(local / 0.6)
    lg = A["kv_logo"]
    put_panel(c, (W - 900) // 2, 260 + int(20 * (1 - a)), 900, 420, radius=36, shadow=False)
    c.alpha_composite(lg, ((W - lg.width) // 2, 470 - lg.height // 2 + int(20 * (1 - a))))
    if local > 0.5:
        tx(d, (W // 2, 790), "Earn  ·  Impact  ·  Elevate", 48, (220, 252, 231), FS, "mm")


def v_badges(c, v, local, words, A, sec):
    d = ImageDraw.Draw(c)
    eyebrow(d, sec)
    c.alpha_composite(A["r3"], (LX, TOP + 100))
    tx(d, (LX + 200, TOP + 120), "3R ZeroWaste", 64, INK, FX)
    tx(d, (LX + 200, TOP + 205), "The team behind KarmaVerse", 32, MUTED, FS)
    para(d, (LX, TOP + 330), "A waste and recycling business with years on the ground, now building India's recycling app.", 34, MUTED, 720, FS)
    icons = ["calendar", "award", "check"]
    for i, b in enumerate(v["badges"]):
        t0 = key_time(words, b.get("key"))
        if t0 is not None and local < t0:
            continue
        a = appear(local, t0)
        y = TOP + 40 + i * 235 + int(30 * (1 - a))
        put_panel(c, RX, y, 790, 200)
        badge_icon(c, icons[i], RX + 110, y + 100)
        tx(d, (RX + 210, y + 62), b["big"], 50, INK, FB)
        tx(d, (RX + 210, y + 128), b["small"], 32, MUTED, FS)


def v_counter(c, v, local, words, A, sec):
    d = ImageDraw.Draw(c)
    eyebrow(d, sec)
    tx(d, (LX, TOP + 100), v.get("pre", ""), 44, MUTED, FS)
    t0 = key_time(words, v.get("key")) or 0.3
    n = v["value"] * ease((local - t0) / 1.6) if local > t0 else 0
    tx(d, (LX - 8, TOP + 160), indian(n), 230, DEEP, FX)
    tx(d, (LX, TOP + 450), v["label"] + ", " + v.get("label2", ""), 52, INK, FB)
    tx(d, (LX, TOP + 700), v.get("source", ""), 26, MUTED, FR)
    # Right: what that means per day, as a calm fact card.
    a = appear(local, t0 + 1.0)
    if local > t0 + 1.0:
        put_panel(c, RX + 300, TOP + 120 + int(30 * (1 - a)), 500, 420)
        badge_icon(c, "truck", RX + 410, TOP + 230 + int(30 * (1 - a)))
        tx(d, (RX + 340, TOP + 330 + int(30 * (1 - a))), "City waste,", 40, INK, FB)
        tx(d, (RX + 340, TOP + 385 + int(30 * (1 - a))), "every single day", 40, INK, FB)
        tx(d, (RX + 340, TOP + 450 + int(30 * (1 - a))), "across urban India", 30, MUTED, FS)


def v_ring(c, v, local, words, A, sec):
    d = ImageDraw.Draw(c)
    eyebrow(d, sec)
    tx(d, (LX, TOP + 100), v.get("pre", ""), 44, MUTED, FS)
    para(d, (LX, TOP + 180), "Nearly 40% of it never gets processed.", 72, INK, 760, FX)
    tx(d, (LX, TOP + 700), v.get("source", ""), 26, MUTED, FR)
    t0 = key_time(words, v.get("key")) or 0.2
    frac = v["value"] / 100 * ease((local - t0) / 1.3) if local > t0 else 0
    cx, cy, r = RX + 400, 520, 270
    d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=LINE, width=56)
    if frac > 0:
        d.arc((cx - r, cy - r, cx + r, cy + r), -90, -90 + 360 * frac, fill=RED, width=56)
    tx(d, (cx, cy - 20), f"{round(frac * 100)}%", 150, RED, FX, "mm")
    tx(d, (cx, cy + 90), v["label"], 34, MUTED, FS, "mm")


def v_questions(c, v, local, words, A, sec):
    d = ImageDraw.Draw(c)
    eyebrow(d, sec)
    para(d, (LX, TOP + 90), "People want to recycle. But they don't know…", 66, INK, 760, FX)
    for i, q in enumerate(v["items"]):
        t0 = key_time(words, q.get("key"))
        if t0 is None or local < t0:
            continue
        a = appear(local, t0)
        y = TOP + 40 + i * 235
        x = RX + int(40 * (1 - a))
        put_panel(c, x, y, 790, 200)
        badge_icon(c, "question", x + 110, y + 100, bg=(254, 243, 199), color=GOLD)
        tx(d, (x + 210, y + 100), q["text"], 50, INK, FB, "lm")


FEATURES = [("Choose items", "box"), ("Book a slot", "calendar"), ("Live tracking", "truck"),
            ("Agent verifies", "check"), ("Wallet", "award"), ("Quiz & rewards", "leaf")]


def v_demo(c, v, local, words, A, sec, footage, dur):
    d = ImageDraw.Draw(c)
    eyebrow(d, sec)
    para(d, (LX, TOP + 90), v.get("title", ""), 58, INK, 760, FX, max_lines=2)
    on = v.get("chip", -1)
    for i, (label, ic) in enumerate(FEATURES):
        y = TOP + 300 + i * 74
        active = i == on
        done = on > i
        if active:
            d.rounded_rectangle((LX - 16, y - 8, LX + 520, y + 58), 18, fill=MINT)
        c.alpha_composite(icon(ic, 46, GREEN if (active or done) else (170, 180, 175), 9), (LX, y))
        tx(d, (LX + 70, y + 24), label, 34, INK if active else (MUTED if done else (160, 170, 165)), FB if active else FS, "lm")
    split = v.get("split")
    size = (700, 652) if split else (322, 713)
    footage.load(v["id"], v["segs"], size)
    fr = footage.frame(local, dur)
    if split:
        x, y = RX - 40, TOP + 20
        put_panel(c, x, y, size[0] + 40, size[1] + 90, radius=24)
        tx(d, (x + 20 + size[0] * 0.28, y + 45), "Customer app", 28, MUTED, FB, "mm")
        tx(d, (x + 20 + size[0] * 0.78, y + 45), "Agent app", 28, MUTED, FB, "mm")
        c.paste(fr, (x + 20, y + 80))
    else:
        b = 14
        pw, ph = size[0] + 2 * b, size[1] + 2 * b
        x, y = RX + 230, TOP - 10
        sh = Image.new("RGBA", (pw + 80, ph + 80), (0, 0, 0, 0))
        ImageDraw.Draw(sh).rounded_rectangle((40, 52, pw + 40, ph + 52), 52, fill=(0, 0, 0, 70))
        c.alpha_composite(sh.filter(ImageFilter.GaussianBlur(20)), (x - 40, y - 40))
        d.rounded_rectangle((x, y, x + pw, y + ph), 52, fill=(17, 24, 39))
        m = Image.new("L", size, 0)
        ImageDraw.Draw(m).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), 40, fill=255)
        c.paste(fr, (x + b, y + b), m)


def v_model(c, v, local, words, A, sec):
    d = ImageDraw.Draw(c)
    stage = v.get("stage", 0)
    eyebrow(d, sec)
    tx(d, (LX, TOP + 90), "The waste itself is the value.", 60, INK, FX)
    g = local if stage == 0 else 9.0

    def node(x, y, w, h, ic, label, sub, dark=False, num=None, hi=False, a=1.0):
        if a <= 0:
            return
        yy = y + int(20 * (1 - a))
        put_panel(c, x, yy, w, h, radius=22, fill=DEEP if dark else (255, 255, 255))
        if hi:
            d.rounded_rectangle((x - 5, yy - 5, x + w + 5, yy + h + 5), 26, outline=GOLD, width=6)
        c.alpha_composite(icon(ic, 64, (255, 255, 255) if dark else GREEN, 9), (x + 28, yy + (h - 64) // 2))
        tx(d, (x + 110, yy + h // 2 - 20), label, 34, (255, 255, 255) if dark else INK, FB, "lm")
        tx(d, (x + 110, yy + h // 2 + 24), sub, 24, MINT if dark else MUTED, FS, "lm")
        if num:
            d.ellipse((x + w - 58, yy - 24, x + w + 6, yy + 40), fill=GOLD)
            tx(d, (x + w - 26, yy + 8), str(num), 34, (255, 255, 255), FX, "mm")

    def arrow(x0, y0, x1, y1, p, t):
        if p <= 0:
            return
        xe, ye = x0 + (x1 - x0) * p, y0 + (y1 - y0) * p
        d.line((x0, y0, xe, ye), fill=(160, 190, 170), width=5)
        if p >= 0.98:
            ang = math.atan2(y1 - y0, x1 - x0)
            d.polygon([(x1, y1), (x1 - 20 * math.cos(ang - 0.45), y1 - 20 * math.sin(ang - 0.45)), (x1 - 20 * math.cos(ang + 0.45), y1 - 20 * math.sin(ang + 0.45))], fill=(160, 190, 170))
            k = (t * 0.7) % 1.0
            px, py = x0 + (x1 - x0) * k, y0 + (y1 - y0) * k
            d.ellipse((px - 8, py - 8, px + 8, py + 8), fill=GOLD)

    yA = 470
    node(LX, yA, 340, 130, "home", "Homes", "old items, e-waste", a=ease(g / 0.4))
    arrow(LX + 340, yA + 65, LX + 395, yA + 65, ease((g - 0.4) / 0.4), local)
    node(LX + 400, yA, 390, 130, "phone", "KarmaVerse app", "pickups, coins, rewards", dark=True, a=ease((g - 0.6) / 0.4))
    arrow(LX + 790, yA + 65, LX + 845, yA + 65, ease((g - 1.0) / 0.4), local)
    node(LX + 850, yA, 370, 130, "factory", "3R ZeroWaste", "sorts & processes", dark=True, a=ease((g - 1.2) / 0.4))
    if stage >= 1:
        a = ease(local / 0.5) if stage == 1 else 1
        arrow(LX + 1220, yA + 40, LX + 1290, 340, a, local)
        node(LX + 1290, 270, 370, 140, "truck", "Recyclers", "core revenue today", num=1, hi=stage == 1, a=a)
    if stage >= 2:
        a = ease(local / 0.5) if stage == 2 else 1
        arrow(LX + 1220, yA + 90, LX + 1290, 670, a, local)
        node(LX + 1290, 600, 370, 140, "box", "B2B products", "for business buyers", num=2, hi=stage == 2, a=a)
    if stage >= 3:
        a = ease(local / 0.5) if stage == 3 else 1
        arrow(LX + 1035, 740, LX + 1035, yA + 135, a, local)
        node(LX + 800, 740, 470, 130, "handshake", "Brand CSR partners", "awareness & campaigns", num=3, hi=stage == 3, a=a)
    if stage >= 4:
        a = ease(local / 0.5)
        if a > 0.2:
            d.rounded_rectangle((LX, 790, LX + 760, 860), 35, fill=MINT)
            tx(d, (LX + 380, 825), "More users  →  more supply  →  more revenue", 32, DEEP, FB, "mm")


def v_stats(c, v, local, words, A, sec):
    d = ImageDraw.Draw(c)
    eyebrow(d, sec)
    tx(d, (LX, TOP + 90), "Not an idea on paper.", 64, INK, FX)
    cw, gap = 390, 30
    for i, item in enumerate(v["cards"]):
        if i not in v.get("show", []) and str(i) not in v.get("reveal", {}):
            continue
        key = v.get("reveal", {}).get(str(i))
        t0 = key_time(words, key) if key else None
        if key and t0 is None:
            t0 = 0.0
        if t0 is not None and local < t0:
            continue
        a = appear(local, t0)
        x, y = LX + i * (cw + gap), 400 + int(30 * (1 - a))
        put_panel(c, x, y, cw, 380)
        d.rectangle((x, y, x + cw, y + 8), fill=GOLD if i == 0 else GREEN)
        k = ease((local - t0) / 1.2) if t0 is not None else 1.0
        val = item["value"] * k
        s = item.get("pre", "") + (f"{val:.1f}" if isinstance(item["value"], float) else indian(val))
        big = 110 if len(s) <= 4 else 92
        if item.get("tag") and k > 0.95:
            tf = font(FB, 26)
            tw2 = d.textlength(item["tag"], font=tf)
            d.rounded_rectangle((x + cw - tw2 - 70, y + 30, x + cw - 30, y + 74), 22, fill=MINT)
            tx(d, (x + cw - 50 - tw2 / 2, y + 52), item["tag"], 26, DEEP, FB, "mm")
        tx(d, (x + 40, y + 60 + (110 - big)), s, big, DEEP, FX)
        unit = item.get("unit", "").strip()
        if unit:
            tw = d.textlength(s, font=font(FX, big))
            tx(d, (x + 50 + tw, y + 125), unit, 36, GREEN, FB)
        para(d, (x + 40, y + 230), item["label"], 32, MUTED, cw - 70, FS, max_lines=3)


def v_ask(c, v, local, words, A, sec):
    d = ImageDraw.Draw(c)
    eyebrow(d, sec)
    tx(d, (LX, TOP + 100), "We're raising", 48, MUTED, FS)
    a = ease(local / 0.6)
    tx(d, (LX - 6, TOP + 160 + int(20 * (1 - a))), v.get("amount", "₹5 Crore"), 170, DEEP, FX)
    para(d, (LX, TOP + 400), "to take KarmaVerse to more cities, build AI, and grow our community.", 38, MUTED, 720, FS)
    icons = ["city", "chip", "people"]
    for i, u in enumerate(v["uses"]):
        t0 = key_time(words, u.get("key"))
        if t0 is not None and local < t0:
            continue
        a = appear(local, t0)
        y = TOP + 40 + i * 235 + int(30 * (1 - a))
        put_panel(c, RX, y, 790, 200)
        badge_icon(c, icons[i], RX + 110, y + 100)
        tx(d, (RX + 210, y + 62), u["big"], 48, INK, FB)
        tx(d, (RX + 210, y + 128), u["small"], 30, MUTED, FS)


def v_end(c, v, local, words, A, sec):
    d = ImageDraw.Draw(c)
    d.rectangle((0, 0, W, H), fill=DEEP + (255,))
    a = ease(local / 0.6)
    put_panel(c, (W - 900) // 2, 150 + int(20 * (1 - a)), 900, 360, radius=36, shadow=False)
    lg = A["kv_logo"]
    c.alpha_composite(lg, ((W - lg.width) // 2, 330 - lg.height // 2 + int(20 * (1 - a))))
    f = font(FX, 66)
    trio = ["Earn", "Impact", "Elevate"]
    sep = "   ·   "
    total = sum(d.textlength(t, font=f) for t in trio) + 2 * d.textlength(sep, font=f)
    x = (W - total) / 2
    for i, t in enumerate(trio):
        t0 = key_time(words, t, last=True)
        if t0 is None or local >= t0:
            d.text((x, 610), t, font=f, fill=(255, 255, 255) if i != 1 else (250, 204, 21), anchor="lm")
            if i < 2:
                d.text((x + d.textlength(t, font=f), 610), sep, font=f, fill=(74, 222, 128), anchor="lm")
        x += d.textlength(t, font=f) + d.textlength(sep, font=f)
    if local > 1.0:
        tx(d, (W // 2, 730), v.get("site", "karmaverse.earth"), 46, (220, 252, 231), FB, "mm")
        tx(d, (W // 2, 800), "Get KarmaVerse on Google Play & the App Store", 32, (167, 243, 208), FS, "mm")
        if v.get("contact"):
            tx(d, (W // 2, 855), v["contact"], 30, (167, 243, 208), FS, "mm")
        tx(d, (W // 2, 930), "A 3R ZeroWaste initiative  ·  SIIC IIT Kanpur  ·  DPIIT-recognised", 26, (134, 199, 160), FS, "mm")


def v_edge(c, v, local, words, A, sec):
    """'Why us': a headline plus three proof cards that pop in on their keywords."""
    d = ImageDraw.Draw(c)
    eyebrow(d, sec)
    tx(d, (LX, TOP + 90), v["head"], 64, INK, FX)
    para(d, (LX, TOP + 190), v.get("sub", ""), 34, MUTED, 1400, FS)
    cw, gap = 530, 30
    for i, b in enumerate(v["items"]):
        t0 = key_time(words, b.get("key"))
        if t0 is not None and local < t0:
            continue
        a = appear(local, t0)
        x, y = LX + i * (cw + gap), 430 + int(30 * (1 - a))
        put_panel(c, x, y, cw, 300)
        d.rectangle((x, y, x + cw, y + 8), fill=GOLD if i == 0 else GREEN)
        badge_icon(c, b["icon"], x + 90, y + 100)
        tx(d, (x + 40, y + 175), b["big"], 42, INK, FB)
        para(d, (x + 40, y + 232), b["small"], 30, MUTED, cw - 70, FS, max_lines=2)


VISUALS = {"corner": v_corner, "brand": v_brand, "badges": v_badges, "counter": v_counter, "ring": v_ring,
           "questions": v_questions, "model": v_model, "stats": v_stats, "ask": v_ask, "end": v_end, "edge": v_edge}
DARK = {"brand", "end"}
FIXES = {"SIICIIT": "SIIC, IIT"}   # letter-by-letter words that run together in captions


# ---------------------------------------------------------------- chrome: top bar, progress, subtitles

def base(A):
    bg = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(bg)
    d.ellipse((W - 520, -380, W + 380, 520), fill=(236, 246, 240))   # soft brand shape, top right
    lg = A["kv_small"]
    bg.paste(lg, (LX, 40), lg)
    x = LX + lg.width + 26
    d.line((x, 48, x, 92), fill=LINE, width=2)
    r3 = A["r3_small"]
    bg.paste(r3, (x + 24, 38), r3)
    return bg


def chrome(frame, names, sec_i, tt, total, dark):
    d = ImageDraw.Draw(frame)
    label = f"{sec_i + 1:02d} / {len(names):02d}    {names[sec_i].upper()}"
    tx(d, (W - LX, 70), label, 24, (167, 243, 208) if dark else MUTED, FB, "rm")
    d.rectangle((0, 0, W, 6), fill=(18, 74, 42) if dark else LINE)
    d.rectangle((0, 0, int(W * tt / total), 6), fill=GOLD)


def repunctuate(words, say):
    """TTS word timings drop punctuation; copy trailing , : . ? ! back from the script text."""
    toks = say.split()
    key = lambda t: re.sub(r"[^\w]", "", t.lower())
    out, j = [], 0
    for a, b, w in words:
        for k in range(j, min(j + 5, len(toks))):
            if key(toks[k]) == key(w):
                m = re.search(r"[,:.?!]+$", toks[k])
                if m and not w.endswith(m.group()):
                    w += m.group()
                j = k + 1
                break
        out.append((a, b, w))
    return out


def chunk_words(words, size=11):
    out = [words[i:i + size] for i in range(0, len(words), size)]
    if len(out) > 1 and len(out[-1]) < 4:
        tail = out.pop()
        out[-1] = out[-1] + tail
    return out


def subtitle(frame, words, local, dark):
    if not words:
        return
    cs = chunk_words(words)
    ci = max([i for i, ch in enumerate(cs) if ch[0][0] <= local + 0.05] or [0])
    s = " ".join(w for _, _, w in cs[ci])
    d = ImageDraw.Draw(frame, "RGBA")
    f = font(FS, 36)
    lines = wrap(d, s, f, 1300)[:2]
    lh = 48
    bh = len(lines) * lh + 30
    y0 = 1030 - bh
    tw = max(d.textlength(ln, font=f) for ln in lines)
    d.rounded_rectangle((W / 2 - tw / 2 - 32, y0, W / 2 + tw / 2 + 32, y0 + bh), 16,
                        fill=(255, 255, 255, 40) if dark else (5, 46, 22, 225))
    for i, ln in enumerate(lines):
        d.text((W / 2, y0 + 15 + i * lh + lh / 2), ln, font=f, fill=(255, 255, 255), anchor="mm")


# ---------------------------------------------------------------- render

def render(spec, stills_dir=None):
    ff = spec.get("ffmpeg") or str(ROOT / "node_modules" / "ffmpeg-static" / "ffmpeg.exe")
    pro = spec.get("pro", {})
    voice, rate, pitch = pro.get("voice", "en-IN-PrabhatNeural"), pro.get("rate", "+11%"), pro.get("pitch", "+0Hz")
    lines, names = spec["lines"], spec["sections"]
    work = tempfile.mkdtemp(prefix="pitchpro-")
    cache = ROOT / "data" / "pitch" / ".voice-cache"
    cache.mkdir(parents=True, exist_ok=True)

    clips = []
    for i, ln in enumerate(lines):
        h = hashlib.sha1(f"{voice}|{rate}|{pitch}|{ln['say']}".encode()).hexdigest()[:16]
        mp3, wj = str(cache / f"{h}.mp3"), cache / f"{h}.json"
        if wj.exists() and os.path.exists(mp3):
            words = [tuple(w) for w in json.loads(wj.read_text(encoding="utf-8"))]
        else:
            words = eb.tts_words(ln["say"], mp3, voice, rate, pitch)
            wj.write_text(json.dumps(words), encoding="utf-8")
        samples = eb.decode(ff, mp3)
        fixed = repunctuate([(a, b, FIXES.get(w, w)) for a, b, w in merge_letters(words)], ln["say"])
        clips.append((mp3, len(samples) / 16000, fixed))
        print(f"voice {i + 1}/{len(lines)}: {clips[-1][1]:.1f}s", flush=True)

    holds = [float(ln.get("hold", 0)) for ln in lines]
    voice_wav = os.path.join(work, "voice.wav")
    ins, filt = [], []
    for i, cl in enumerate(clips):
        ins += ["-i", cl[0]]
        filt.append(f"[{i}:a]aresample=48000,apad=pad_dur={GAP + holds[i]}[a{i}]")
    filt.append("".join(f"[a{i}]" for i in range(len(clips))) + f"concat=n={len(clips)}:v=0:a=1[v]")
    subprocess.run([ff, "-y", "-loglevel", "error", *ins, "-filter_complex", ";".join(filt), "-map", "[v]", voice_wav], check=True)

    lead = 0.8
    starts, t = [], lead
    for i, cl in enumerate(clips):
        starts.append(t)
        t += cl[1] + GAP + holds[i]
    total = t + 0.5
    group_start = []
    for i, ln in enumerate(lines):
        g = ln["visual"].get("group")
        group_start.append(group_start[i - 1] if i and g and lines[i - 1]["visual"].get("group") == g else i)
    print(f"total {total:.1f}s", flush=True)

    kv = logo_crop(spec["logo"], 200)
    if kv.width > 780:
        kv = kv.resize((780, int(200 * 780 / kv.width)), Image.LANCZOS)
    A = {"kv_logo": kv, "kv_small": logo_crop(spec["logo"], 60),
         "r3": Image.open(spec["partnerLogo"]).convert("RGBA").resize((170, 170), Image.LANCZOS),
         "r3_small": Image.open(spec["partnerLogo"]).convert("RGBA").resize((68, 68), Image.LANCZOS)}
    bg = base(A)
    footage = Footage(ff)

    silent = os.path.join(work, "video.mp4")
    nframes = int(total * FPS)
    if stills_dir:
        os.makedirs(stills_dir, exist_ok=True)
        todo, proc = [int((starts[i] + clips[i][1] * 0.85) * FPS) for i in range(len(lines))], None
    else:
        todo = range(nframes)
        proc = subprocess.Popen([ff, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                                 "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-g", "60", silent], stdin=subprocess.PIPE)
    for fi in todo:
        tt = fi / FPS
        li = max([i for i, s in enumerate(starts) if s <= tt] or [0])
        ln, cl = lines[li], clips[li]
        local, dur, words = tt - starts[li], cl[1], cl[2]
        v = ln["visual"]
        dark = v["type"] in DARK
        sec = names[ln["section"]]

        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        if v["type"] == "demo":
            v_demo(layer, v, local, words, A, sec, footage, dur)
        else:
            VISUALS[v["type"]](layer, v, local, words, A, sec)
        glocal = tt - starts[group_start[li]]
        a = ease(glocal / 0.5) if tt > lead else 1.0
        frame = bg.copy()
        if a < 0.999:
            layer.putalpha(layer.getchannel("A").point(lambda x: int(x * a)))
        frame.paste(layer, (0, int(24 * (1 - a))), layer)
        chrome(frame, names, ln["section"], tt, total, dark)
        subtitle(frame, words, local, dark)

        if proc is None:
            frame.save(os.path.join(stills_dir, f"pro{li + 1:02d}.png"))
            continue
        proc.stdin.write(frame.tobytes())
        if fi % 600 == 0:
            print(f"frame {fi}/{nframes}", flush=True)
    if proc is None:
        print(f"stills saved to {stills_dir}", flush=True)
        return
    proc.stdin.close()
    if proc.wait() != 0:
        raise SystemExit("ffmpeg failed while encoding frames")

    out = pro.get("out", "data/videos/karmaverse-pitch-16x9.mp4")
    out = out if os.path.isabs(out) else str(ROOT / out)
    st = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo"
    ms = int(lead * 1000)
    ins = ["-i", silent, "-i", voice_wav]
    filt = [f"[1:a]{st},adelay={ms}|{ms},apad[v]"]
    music = pro.get("music", spec.get("music"))
    if music:
        music = music if os.path.isabs(music) else str(ROOT / music)
    if music and os.path.exists(music):
        ins += ["-stream_loop", "-1", "-i", music]
        filt.append(f"[2:a]{st},volume={pro.get('musicVolume', 0.06)},afade=t=in:d=2,afade=t=out:st={total - 3:.2f}:d=3[m]")
        filt.append(f"[v][m]amix=inputs=2:duration=first:normalize=0,atrim=0:{total:.2f},loudnorm=I=-16:TP=-1.5:LRA=11[a]")
    else:
        filt.append(f"[v]atrim=0:{total:.2f},loudnorm=I=-16:TP=-1.5:LRA=11[a]")
    subprocess.run([ff, "-y", "-loglevel", "error", *ins, "-filter_complex", ";".join(filt), "-map", "0:v", "-map", "[a]",
                    "-c:v", "copy", "-c:a", "aac", "-ar", "48000", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out], check=True)
    print(json.dumps({"file": out, "durationSec": round(total, 1)}), flush=True)


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as f:
        sp = json.load(f)
    for k in ("logo", "partnerLogo"):
        if not os.path.isabs(sp[k]):
            sp[k] = str(ROOT / sp[k])
    render(sp, sys.argv[3] if len(sys.argv) > 3 and sys.argv[2] == "--stills" else None)
