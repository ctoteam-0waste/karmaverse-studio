"""Draws the KarmaVerse video cast as talking-character images.

Usage: python characters.py OUT_DIR

For each character it writes three PNGs, <id>-0.png (mouth closed), <id>-1.png
(half open) and <id>-2.png (open), 1152x1280 on a white background, the same
canvas as the Earth Buddy mascot. earth_buddy.py cuts the white away and swaps
the three frames by voice loudness, so every character lip-syncs.

Rules that keep the cut-out clean: the white background touches every edge and
the middle of the bottom edge, and every white part inside a character (eyes,
teeth) is fully outlined so the flood fill can't reach it. Heads sit in the top
870 px, where the chat-style video crops its avatar.
"""
import json
import math
import os
import sys

from PIL import Image, ImageDraw, ImageFilter

W, H = 1152, 1280
S = 2  # drawn at 2x and scaled down for smooth edges
INK = (38, 30, 32)
WHITE = (255, 255, 255)


def P(*v):
    return [int(round(x * S)) for x in v]


class Canvas:
    def __init__(self):
        self.im = Image.new("RGB", (W * S, H * S), WHITE)
        self.d = ImageDraw.Draw(self.im)

    def ellipse(self, box, fill, outline=INK, width=9):
        self.d.ellipse(P(*box), fill=fill, outline=outline, width=width * S if outline else 0)

    def rrect(self, box, r, fill, outline=INK, width=9):
        self.d.rounded_rectangle(P(*box), radius=r * S, fill=fill, outline=outline, width=width * S if outline else 0)

    def poly(self, pts, fill, outline=INK, width=9):
        flat = [c for p in pts for c in P(*p)]
        self.d.polygon(flat, fill=fill)
        if outline:
            self.d.line(flat + flat[:2], fill=outline, width=width * S, joint="curve")

    def line(self, pts, fill=INK, width=9):
        flat = [c for p in pts for c in P(*p)]
        self.d.line(flat, fill=fill, width=width * S, joint="curve")

    def arc(self, box, start, end, fill=INK, width=9):
        self.d.arc(P(*box), start, end, fill=fill, width=width * S)

    def chord(self, box, start, end, fill, outline=INK, width=9):
        self.d.chord(P(*box), start, end, fill=fill, outline=outline, width=width * S)

    def done(self):
        return self.im.resize((W, H), Image.LANCZOS)


# ------------------------------------------------------------------ face parts

def eyes(c, cx, cy, gap=95, rx=46, ry=54, look=(6, 6), lashes=False, glasses=False):
    for sx in (-1, 1):
        x = cx + sx * gap
        c.ellipse((x - rx, cy - ry, x + rx, cy + ry), WHITE, width=7)
        px, py = x + look[0], cy + look[1]
        c.ellipse((px - 24, py - 26, px + 24, py + 26), (52, 36, 30), outline=None)
        c.ellipse((px - 11, py - 22, px + 5, py - 6), WHITE, outline=None)
        if lashes:
            c.line([(x - rx + 4, cy - ry + 18), (x - rx - 16, cy - ry + 2)], width=7)
            c.line([(x + rx - 4, cy - ry + 18), (x + rx + 16, cy - ry + 2)], width=7)
        if glasses:
            c.ellipse((x - rx - 16, cy - ry - 12, x + rx + 16, cy + ry + 12), None, outline=(90, 60, 40), width=8)
    if glasses:
        c.line([(cx - gap + rx + 16, cy), (cx + gap - rx - 16, cy)], fill=(90, 60, 40), width=8)


def brows(c, cx, cy, gap=95, lift=0, col=INK, w=11):
    for sx in (-1, 1):
        x = cx + sx * gap
        c.arc((x - 46, cy - 30 - lift, x + 46, cy + 20 - lift), 200 if sx < 0 else 220, 320 if sx < 0 else 340, fill=col, width=w)


def cheeks(c, cx, cy, gap=150, col=(255, 150, 150)):
    for sx in (-1, 1):
        x = cx + sx * gap
        c.ellipse((x - 34, cy - 20, x + 34, cy + 20), col, outline=None)


def mouth(c, cx, cy, state, w=110, lip=INK):
    """state 0 = closed smile, 1 = half open, 2 = open. Every part is outlined."""
    if state == 0:
        c.arc((cx - w / 2, cy - w * 0.42, cx + w / 2, cy + w * 0.32), 20, 160, fill=lip, width=10)
        return
    hgt = w * (0.5 if state == 1 else 0.85)
    ww = w * (0.9 if state == 1 else 1.0)
    box = (cx - ww / 2, cy - hgt * 0.3, cx + ww / 2, cy + hgt * 0.7)
    c.ellipse(box, (110, 24, 36), outline=lip, width=9)
    # thin upper-teeth strip and a tongue, inside the outline
    c.chord((box[0] + ww * 0.16, box[1] + 4, box[2] - ww * 0.16, box[1] + hgt * 0.34), 180, 360, (250, 248, 240), outline=None)
    c.chord((cx - ww * 0.3, cy + hgt * 0.22, cx + ww * 0.3, box[3] - 6), 180, 360, (232, 96, 110), outline=None)


def human_head(c, cx, cy, r, skin, state, **kw):
    # ears
    for sx in (-1, 1):
        c.ellipse((cx + sx * r - 34, cy - 10, cx + sx * r + 34, cy + 70), skin)
    c.ellipse((cx - r, cy - r * 1.02, cx + r, cy + r * 0.98), skin, width=10)
    cheeks(c, cx, cy + 80, gap=r * 0.6)
    eyes(c, cx, cy + 6, gap=r * 0.38, **{k: v for k, v in kw.items() if k in ("lashes", "glasses", "look")})
    brows(c, cx, cy - 64, gap=r * 0.38, col=kw.get("brow", INK))
    c.arc((cx - 16, cy + 36, cx + 16, cy + 74), 300, 60, fill=(150, 90, 70), width=7)  # nose
    mouth(c, cx, cy + 128, state, w=kw.get("mouth_w", 124))


def torso(c, cx, top, w, col, bottom=1236, neck_skin=None, collar=None):
    if neck_skin:
        c.rrect((cx - 52, top - 60, cx + 52, top + 20), 20, neck_skin)
    c.rrect((cx - w / 2, top, cx + w / 2, bottom), 120, col, width=10)
    if collar:
        c.poly([(cx - 70, top + 4), (cx, top + 80), (cx + 70, top + 4)], collar, width=8)


def arm(c, x0, y0, x1, y1, sleeve, skin, w=74):
    c.line([(x0, y0), (x1, y1)], fill=INK, width=w + 18)
    c.line([(x0, y0), (x1, y1)], fill=sleeve, width=w)
    c.ellipse((x1 - 40, y1 - 40, x1 + 40, y1 + 40), skin, width=8)


def leaf(c, x, y, s, ang, col=(70, 170, 80)):
    pts = []
    for i in range(0, 361, 20):
        t = math.radians(i)
        px, py = math.cos(t) * s, math.sin(t) * s * 0.45
        a = math.radians(ang)
        pts.append((x + px * math.cos(a) - py * math.sin(a), y + px * math.sin(a) + py * math.cos(a)))
    c.poly(pts, col, width=6)


def recycle_badge(c, cx, cy, r, col=(255, 255, 255), ring=(46, 140, 80)):
    c.ellipse((cx - r, cy - r, cx + r, cy + r), ring, width=8)
    for k in range(3):
        a0 = math.radians(k * 120 - 90)
        a1 = math.radians(k * 120 - 10)
        pts = [(cx + math.cos(a0 + (a1 - a0) * t / 6) * r * 0.58, cy + math.sin(a0 + (a1 - a0) * t / 6) * r * 0.58) for t in range(7)]
        c.line(pts, fill=col, width=int(r * 0.16))
        ex, ey = pts[-1]
        ang = a1 + math.pi / 2
        c.poly([(ex + math.cos(ang) * r * 0.2, ey + math.sin(ang) * r * 0.2),
                (ex + math.cos(ang + 2.2) * r * 0.18, ey + math.sin(ang + 2.2) * r * 0.18),
                (ex + math.cos(ang - 2.2) * r * 0.18, ey + math.sin(ang - 2.2) * r * 0.18)], col, outline=None)


# ------------------------------------------------------------------ the cast

SKIN = (233, 180, 130)
SKIN_D = (196, 140, 98)
SKIN_L = (240, 196, 152)


def chhotu(state):
    c = Canvas()
    cx = 576
    torso(c, cx, 760, 520, (52, 168, 92), neck_skin=SKIN, collar=(40, 130, 70))
    recycle_badge(c, cx, 960, 78)
    arm(c, cx - 250, 820, cx - 330, 1080, (52, 168, 92), SKIN)
    arm(c, cx + 250, 820, cx + 360, 620, (52, 168, 92), SKIN)  # waving
    c.ellipse((cx + 318, 520, cx + 410, 612), SKIN)  # open palm
    # spiky hair behind the head
    spikes = [(cx - 260, 300), (cx - 230, 150), (cx - 150, 210), (cx - 90, 90), (cx, 180), (cx + 80, 80), (cx + 150, 200), (cx + 240, 140), (cx + 262, 300)]
    c.poly(spikes + [(cx, 330)], (34, 26, 24), width=8)
    human_head(c, cx, 440, 250, SKIN, state)
    c.chord((cx - 250, 180, cx + 250, 430), 180, 360, (34, 26, 24), width=8)  # fringe
    return c.done()


def pinky(state):
    c = Canvas()
    cx = 576
    # dress (trapezoid)
    c.rrect((cx - 52, 700, cx + 52, 780), 20, SKIN)
    c.poly([(cx - 200, 770), (cx + 200, 770), (cx + 300, 1236), (cx - 300, 1236)], (236, 92, 150), width=10)
    c.rrect((cx - 200, 770, cx + 200, 860), 30, (250, 196, 60), width=8)
    for i in range(5):
        x = cx - 200 + 40 + i * 80
        c.ellipse((x - 14, 1100 - 14, x + 14, 1100 + 14), (255, 230, 120), outline=None)
    arm(c, cx - 190, 830, cx - 300, 1060, (236, 92, 150), SKIN, w=66)
    arm(c, cx + 190, 830, cx + 300, 1060, (236, 92, 150), SKIN, w=66)
    # pigtails with bows
    for sx in (-1, 1):
        x = cx + sx * 300
        c.ellipse((x - 90, 380, x + 90, 640), (40, 28, 26), width=8)
        c.poly([(x - 70, 330), (x, 370), (x - 70, 410)], (236, 92, 150), width=7)
        c.poly([(x + 70, 330), (x, 370), (x + 70, 410)], (236, 92, 150), width=7)
        c.ellipse((x - 22, 348, x + 22, 392), (200, 60, 120), width=6)
    human_head(c, cx, 430, 240, SKIN_L, state, lashes=True, mouth_w=100)
    c.chord((cx - 242, 170, cx + 242, 440), 180, 360, (40, 28, 26), width=8)
    c.poly([(cx - 40, 200), (cx + 60, 200), (cx + 10, 330)], (40, 28, 26), outline=None)  # parting
    return c.done()


def didi(state):
    c = Canvas()
    cx = 576
    torso(c, cx, 760, 580, (20, 140, 150), neck_skin=SKIN_D)
    # dupatta in KarmaVerse green, across the shoulder
    c.poly([(cx - 290, 790), (cx - 160, 760), (cx + 260, 1236), (cx + 90, 1236)], (78, 186, 90), width=9)
    # cloth bag with a leaf
    arm(c, cx + 280, 820, cx + 360, 1040, (20, 140, 150), SKIN_D)
    c.rrect((cx + 300, 1040, cx + 470, 1220), 24, (245, 225, 180), width=8)
    c.arc((cx + 330, 980, cx + 440, 1090), 180, 360, width=8)
    leaf(c, cx + 385, 1130, 46, -30)
    arm(c, cx - 290, 820, cx - 360, 1060, (20, 140, 150), SKIN_D)
    # ponytail behind
    c.ellipse((cx + 150, 300, cx + 330, 700), (30, 22, 22), width=8)
    human_head(c, cx, 430, 245, SKIN_D, state, lashes=True)
    c.chord((cx - 248, 160, cx + 248, 420), 180, 360, (30, 22, 22), width=8)
    c.ellipse((cx - 14, 336, cx + 14, 364), (210, 40, 60), outline=None)  # bindi
    for sx in (-1, 1):  # earrings
        c.ellipse((cx + sx * 248 - 14, 520, cx + sx * 248 + 14, 548), (250, 196, 60), width=5)
    return c.done()


def dadi(state):
    c = Canvas()
    cx = 576
    torso(c, cx, 760, 600, (250, 236, 200), neck_skin=SKIN_D)
    # saree border and pallu
    c.poly([(cx - 300, 800), (cx - 180, 765), (cx + 300, 1180), (cx + 300, 1236), (cx + 160, 1236)], (160, 30, 60), width=9)
    c.line([(cx - 250, 790), (cx + 260, 1215)], fill=(250, 196, 60), width=14)
    arm(c, cx - 300, 820, cx - 380, 1080, (250, 236, 200), SKIN_D)
    arm(c, cx + 300, 820, cx + 380, 1080, (250, 236, 200), SKIN_D)
    # grey bun
    c.ellipse((cx - 110, 120, cx + 110, 300), (190, 190, 196), width=8)
    human_head(c, cx, 450, 250, SKIN_D, state, glasses=True, brow=(150, 150, 156), mouth_w=104)
    c.chord((cx - 252, 190, cx + 252, 460), 180, 360, (200, 200, 206), width=8)
    c.d.line(P(cx, 200, cx, 300), fill=(150, 150, 156), width=7 * S)  # parting
    c.ellipse((cx - 16, 354, cx + 16, 386), (200, 30, 50), outline=None)  # bindi
    # smile lines
    for sx in (-1, 1):
        c.arc((cx + sx * 130 - 40, 540, cx + sx * 130 + 40, 610), 60 if sx < 0 else 30, 150 if sx < 0 else 120, fill=(150, 100, 80), width=5)
    return c.done()


def binny(state):
    c = Canvas()
    cx = 576
    green, dark = (46, 160, 86), (26, 110, 60)
    # wheels
    for sx in (-1, 1):
        c.ellipse((cx + sx * 190 - 50, 1130, cx + sx * 190 + 50, 1230), (60, 60, 66), width=8)
    # body: tapered bin
    c.poly([(cx - 300, 360), (cx + 300, 360), (cx + 250, 1180), (cx - 250, 1180)], green, width=11)
    for i in range(3):  # ribs
        x = cx - 150 + i * 150
        c.line([(x, 860), (x * 0.98 + cx * 0.02, 1130)], fill=dark, width=10)
    # lid with handle
    c.rrect((cx - 340, 290, cx + 340, 380), 30, dark, width=10)
    c.rrect((cx - 90, 240, cx + 90, 300), 20, dark, width=9)
    # arms
    for sx in (-1, 1):
        c.line([(cx + sx * 280, 700), (cx + sx * 400, 820)], fill=INK, width=44)
        c.line([(cx + sx * 280, 700), (cx + sx * 400, 820)], fill=dark, width=28)
        c.ellipse((cx + sx * 400 - 38, 782, cx + sx * 400 + 38, 858), (250, 250, 250), width=8)  # glove
    eyes(c, cx, 540, gap=110, rx=58, ry=66)
    brows(c, cx, 450, gap=110, w=13)
    mouth(c, cx, 690, state, w=150)
    recycle_badge(c, cx, 970, 95, col=(240, 255, 240), ring=dark)
    return c.done()


def taru(state):
    c = Canvas()
    cx = 576
    trunk, bark = (150, 98, 58), (118, 74, 42)
    # trunk with roots
    c.poly([(cx - 190, 470), (cx + 190, 470), (cx + 230, 1150), (cx + 320, 1225), (cx - 320, 1225), (cx - 230, 1150)], trunk, width=11)
    for x0, y0, y1 in ((cx - 120, 900, 1100), (cx + 110, 880, 1080), (cx - 20, 1000, 1180)):
        c.line([(x0, y0), (x0 + 10, y1)], fill=bark, width=10)
    # branch arms with leaves
    c.line([(cx - 180, 760), (cx - 330, 640), (cx - 400, 660)], fill=INK, width=60)
    c.line([(cx - 180, 760), (cx - 330, 640), (cx - 400, 660)], fill=trunk, width=42)
    c.line([(cx + 180, 760), (cx + 340, 660), (cx + 420, 600)], fill=INK, width=60)
    c.line([(cx + 180, 760), (cx + 340, 660), (cx + 420, 600)], fill=trunk, width=42)
    leaf(c, cx - 430, 640, 60, 200)
    leaf(c, cx + 450, 575, 60, -30)
    # canopy: overlapping leaf clouds
    for (x, y, r, col) in [(-250, 330, 160, (60, 150, 70)), (250, 330, 160, (60, 150, 70)), (-130, 230, 170, (80, 175, 85)),
                           (140, 220, 170, (80, 175, 85)), (0, 320, 210, (96, 190, 96)), (0, 180, 130, (110, 200, 104))]:
        c.ellipse((cx + x - r, y - r, cx + x + r, y + r), col, width=9)
    for (x, y) in [(-200, 240), (180, 280), (40, 150), (-60, 360), (230, 390)]:
        c.ellipse((cx + x - 18, y - 18, cx + x + 18, y + 18), (230, 80, 80), width=5)  # fruit
    # face on the trunk
    eyes(c, cx, 640, gap=80, rx=44, ry=50)
    brows(c, cx, 572, gap=80, col=(80, 50, 30))
    cheeks(c, cx, 720, gap=120, col=(220, 140, 110))
    mouth(c, cx, 780, state, w=120)
    return c.done()


CAST = {"chhotu": chhotu, "pinky": pinky, "didi": didi, "dadi": dadi, "binny": binny, "taru": taru}


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out, exist_ok=True)
    made = []
    only = sys.argv[2:] or list(CAST)
    for cid in only:
        for state in range(3):
            path = os.path.join(out, f"{cid}-{state}.png")
            CAST[cid](state).save(path, optimize=True)
            made.append(path)
    print(json.dumps({"made": made}))


if __name__ == "__main__":
    main()
