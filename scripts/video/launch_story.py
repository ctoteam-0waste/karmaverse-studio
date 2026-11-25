"""Animated "we're live on iOS" launch video with Earth Buddy (1080x1920, 9:16).

Usage: python launch_story.py spec.json
Spec: the same as cartoon_story.py (ffmpeg, work, out, music, logo, partnerLogo,
mascot, voice, rate, pitch, lines, title_small, title_big, cta_top, cta_button,
cta_site, cta_icon, preview), plus:
  quiz_screen      path of the app's quiz screenshot (shown in the phone)
  lines            seven {say, sub}: title, rocket, quiz, invite, grow, party, cta

Scenes: BIG NEWS title over a starry sky, a phone-rocket countdown and lift-off,
the Daily Eco-Quiz with KarmaCoins flying out, two kids sending an invite and a
gift box popping +1,000 XP for both, the world turning green, a launch party,
and the closing card.
"""
import json, math, os, random, sys
from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import earth_buddy as eb  # noqa: E402
import cartoon_story as cs  # noqa: E402
from cartoon_story import W, H, GROUND, INK, clamp, lerp, outlined, burst, sparkles, draw_kid, gradient  # noqa: E402

rnd = random.Random(11)
STARS = [(rnd.uniform(0, W), rnd.uniform(0, H), rnd.uniform(2, 5), rnd.uniform(0, 6.28)) for _ in range(110)]
NIGHT = ((15, 23, 62), (88, 28, 135))
SPACE = ((8, 12, 40), (49, 46, 129))
_cache = {}


def stars(d, t, speed=0.0):
    for x, y0, r, ph in STARS:
        y = (y0 + speed) % H
        tw = 0.55 + 0.45 * math.sin(t * 3 + ph)
        col = (255, 255, 230, int(255 * tw))
        if speed > 40:
            d.line((x, y, x, y - min(140, speed * 0.04) * r / 3), fill=col, width=max(2, int(r * 0.7)))
        else:
            d.ellipse((x - r * tw, y - r * tw, x + r * tw, y + r * tw), fill=col)


def coin(d, x, y, r, t, ph=0.0):
    cw = max(4, r * abs(math.cos(t * 4 + ph)))
    d.ellipse((x - cw, y - r, x + cw, y + r), fill=(250, 204, 21), outline=INK, width=4)
    if cw > r * 0.55:
        d.text((x, y), "K", font=eb.font(eb.FX, int(r * 1.1 * cw / r)), fill=(161, 98, 7), anchor="mm")


def check(d, x, y, s, col=(255, 255, 255)):
    d.line((x - s, y, x - s * 0.3, y + s * 0.7, x + s, y - s * 0.8), fill=col, width=int(s * 0.35), joint="curve")


def pop_text(d, xy, text, size, fill, p, stroke=9):
    if p <= 0:
        return
    s = eb.pop(p) if p < 1 else 1.0
    outlined(d, xy, text, max(8, int(size * s)), fill, stroke=stroke)


# ------------------------------------------------------------- scenes

def scene_title(f, lt, D, t, buddy, lv, sp):
    d = ImageDraw.Draw(f, "RGBA")
    stars(d, t)
    # glowing planet horizon
    d.ellipse((-400, GROUND - 120, W + 400, GROUND + 900), fill=(34, 197, 94))
    d.ellipse((-400, GROUND - 120, W + 400, GROUND + 900), outline=(134, 239, 172), width=14)
    burst(f, W / 2, 380, 230, "BIG NEWS!", (239, 68, 68), (lt - 0.1) / 0.45)
    pop_text(d, (W / 2, 690), sp["title_small"], 74, (255, 255, 255), (lt - 0.7) / 0.4, stroke=8)
    big, size = sp["title_big"], 190
    fnt = eb.font(eb.FX, size)
    gap = 14
    widths = [d.textlength(ch, font=fnt) for ch in big]
    while sum(widths) + gap * (len(big) - 1) > W - 140 and size > 90:
        size -= 6
        fnt = eb.font(eb.FX, size)
        widths = [d.textlength(ch, font=fnt) for ch in big]
    x = W / 2 - (sum(widths) + gap * (len(big) - 1)) / 2
    for i, ch in enumerate(big):
        p = (lt - 1.0 - i * 0.07) / 0.4
        cx = x + widths[i] / 2
        x += widths[i] + gap
        if p <= 0:
            continue
        y = 860 - (1 - cs.bounce(p)) * 500 + math.sin(t * 5 + i) * 10
        outlined(d, (cx, y), ch, size, [(253, 224, 71), (74, 222, 128), (96, 165, 250), (244, 114, 182)][i % 4], stroke=11)
    sparkles(f, W / 2, 800, t, spread=430, n=12)
    jp = (lt - 0.5) / 0.6
    if jp > 0:
        hop = abs(math.sin(lt * 3.4)) * 45
        buddy.draw(f, W / 2, GROUND + 130 - hop + (1 - cs.bounce(jp)) * 600, t, lv, squash=0.07 * math.cos(lt * 6.8), scale=0.72)


def rocket(f, cx, cy, s, t, flame, logo):
    d = ImageDraw.Draw(f, "RGBA")
    w, h = 230 * s, 440 * s
    top, bot = cy - h / 2, cy + h / 2
    if flame > 0:
        fl = (190 + 50 * math.sin(t * 37) + 30 * math.sin(t * 23)) * s * flame
        d.polygon([(cx - 80 * s, bot - 10), (cx + 80 * s, bot - 10), (cx, bot + fl)], fill=(249, 115, 22, 235))
        d.polygon([(cx - 48 * s, bot - 10), (cx + 48 * s, bot - 10), (cx, bot + fl * 0.68)], fill=(253, 224, 71, 245))
        d.polygon([(cx - 22 * s, bot - 10), (cx + 22 * s, bot - 10), (cx, bot + fl * 0.38)], fill=(255, 255, 255, 250))
    for side in (-1, 1):  # fins
        x0 = cx + side * w / 2
        d.polygon([(x0, bot - 170 * s), (x0 + side * 95 * s, bot + 20 * s), (x0, bot - 20 * s)], fill=(239, 68, 68), outline=INK)
        d.line((x0, bot - 170 * s, x0 + side * 95 * s, bot + 20 * s, x0, bot - 20 * s), fill=INK, width=6)
    d.rounded_rectangle((cx - w / 2, top, cx + w / 2, bot), int(52 * s), fill=(17, 24, 39), outline=INK, width=6)
    m = 16 * s
    d.rounded_rectangle((cx - w / 2 + m, top + m, cx + w / 2 - m, bot - m), int(40 * s), fill=(22, 163, 74))
    d.rounded_rectangle((cx - 42 * s, top + 26 * s, cx + 42 * s, top + 46 * s), int(10 * s), fill=(17, 24, 39))
    coin(d, cx, cy - 30 * s, 62 * s, t * 0.6)
    lg = logo.resize((int(160 * s), int(160 * s * logo.height / logo.width)), Image.LANCZOS)
    d.rounded_rectangle((cx - lg.width / 2 - 8, cy + 70 * s - 8, cx + lg.width / 2 + 8, cy + 70 * s + lg.height + 8), 12, fill=(255, 255, 255))
    f.alpha_composite(lg, (int(cx - lg.width / 2), int(cy + 70 * s)))


def scene_rocket(f, lt, D, t, buddy, lv, sp):
    if "logo" not in _cache:
        _cache["logo"] = Image.open(sp["logo"]).convert("RGBA")
    d = ImageDraw.Draw(f, "RGBA")
    c0, c1 = 0.35, 0.35 + (D - 0.35) * 0.42  # countdown window, then lift-off
    lift = clamp((lt - c1) / max(0.5, D - c1 - 0.2))
    speed = (lift ** 1.6) * 5000
    stars(d, t, speed)
    pad_y = 1200
    d.ellipse((-300, pad_y + 20, W + 300, pad_y + 600), fill=(21, 128, 61))
    d.rectangle((W / 2 - 230, pad_y - 10, W / 2 + 230, pad_y + 30), fill=(107, 114, 128), outline=INK, width=6)
    # smoke
    for k in range(18):
        age = lt - (c1 - 0.35) - k * 0.05
        if age <= 0:
            continue
        side = -1 if k % 2 else 1
        x = W / 2 + side * (50 + age * (220 + 30 * (k % 5)))
        y = pad_y + 10 - age * (25 + 6 * (k % 3))
        r = 45 + age * 80
        a = int(max(0, 210 - age * 90))
        d.ellipse((x - r, y - r, x + r, y + r), fill=(229, 231, 235, a))
    shake = math.sin(t * 70) * 7 * clamp((lt - c1 + 0.5) / 0.5) * (1 - lift)
    cy = pad_y - 260 - (lift ** 2) * 1900
    flame = clamp((lt - c1 + 0.45) / 0.3)
    rocket(f, W / 2 + shake, cy, 1.0, t, flame, _cache["logo"])
    # countdown 3-2-1
    step = (c1 - c0) / 3
    for i, txt in enumerate(("3", "2", "1")):
        p = (lt - c0 - i * step) / (step * 0.5)
        if 0 < p and lt < c0 + (i + 1) * step:
            pop_text(d, (W / 2, 330), txt, 300, (253, 224, 71), p, stroke=12)
    if lt > c1:
        pop_text(d, (W / 2, 330), "LIFT OFF!", 150, (255, 255, 255), (lt - c1) / 0.4, stroke=11)
        pop_text(d, (W / 2, 480), "Now on the App Store", 64, (134, 239, 172), (lt - c1 - 0.4) / 0.4, stroke=7)
    hop = abs(math.sin(lt * 5)) * 50 * clamp((lt - c1) / 0.3)
    buddy.draw(f, 190, GROUND + 90 - hop, t, lv, scale=0.62)


def scene_quiz(f, lt, D, t, buddy, lv, sp):
    if "quiz" not in _cache:
        ph = eb.phone_with(sp["quiz_screen"], 440)
        ow, oh = Image.open(sp["quiz_screen"]).size
        sc = (440 - 36) / ow
        _cache["quiz"] = (ph, 18 + 0.686 * oh * sc, sc * ow)
    ph, opt_y, sw = _cache["quiz"]
    d = ImageDraw.Draw(f, "RGBA")
    for k in range(7):  # floating leaves
        x = (k * 173 + t * 40) % W
        y = 300 + (k * 211) % 900 + math.sin(t * 2 + k) * 30
        d.ellipse((x - 26, y - 12, x + 26, y + 12), fill=(74, 222, 128, 140))
    pop_text(d, (W / 2, 250), "Daily Eco-Quiz", 104, (255, 255, 255), (lt - 0.1) / 0.4, stroke=9)
    tx = W / 2 + 140
    px = lerp(W + 300, tx, eb.ease(clamp(lt / 0.6)))
    top = 360
    f.alpha_composite(ph, (int(px - ph.width / 2), top))
    ox, oy = px - ph.width / 2 + 18 + sw / 2, top + opt_y
    tap = lt - 1.0
    if tap > 0:
        r = 30 + tap * 160
        if tap < 0.6:
            d.ellipse((ox - r, oy - r, ox + r, oy + r), outline=(34, 197, 94, int(255 * (1 - tap / 0.6))), width=10)
        bw = sw * 0.9
        d.rounded_rectangle((ox - bw / 2, oy - 28, ox + bw / 2, oy + 28), 14, outline=(34, 197, 94), width=7, fill=(34, 197, 94, 70))
        d.ellipse((ox + bw / 2 - 58, oy - 22, ox + bw / 2 - 14, oy + 22), fill=(34, 197, 94))
        check(d, ox + bw / 2 - 36, oy, 13)
    ex, ey = 230, 560
    for k in range(7):
        p = (lt - 1.4 - k * 0.09) / 0.6
        if 0 < p < 1:
            x = lerp(ox, ex, eb.ease(p))
            y = lerp(oy, ey, p) - math.sin(p * math.pi) * 300
            coin(d, x, y, 34, t, k)
    cp = (lt - 1.9) / 0.4
    if cp > 0:
        s = eb.pop(cp) if cp < 1 else 1.0
        d.rounded_rectangle((ex - 170 * s, ey - 80 * s, ex + 170 * s, ey + 80 * s), int(40 * s), fill=(255, 255, 255), outline=INK, width=6)
        coin(d, ex - 95 * s, ey, 44 * s, t)
        outlined(d, (ex + 45 * s, ey), "+10 XP", int(64 * s), (22, 163, 74), stroke=4)
        sparkles(f, ex, ey, t, spread=200, n=8)
    hop = abs(math.sin(lt * 3)) * 25
    buddy.draw(f, 230, GROUND + 90 - hop, t, lv, scale=0.66)


def plane(d, x, y, ang, s=1.0):
    pts = [(40, 0), (-30, -26), (-14, 0), (-30, 26)]
    ca, sa = math.cos(ang), math.sin(ang)
    P = [(x + (px * ca - py * sa) * s, y + (px * sa + py * ca) * s) for px, py in pts]
    d.polygon(P, fill=(255, 255, 255), outline=INK)
    d.line(P + [P[0]], fill=INK, width=4)


def gift(f, cx, cy, p, lid, t):
    d = ImageDraw.Draw(f, "RGBA")
    s = eb.pop(p) if p < 1 else 1.0
    w, h = 230 * s, 190 * s
    if lid > 0:  # glow
        g = Image.new("RGBA", (700, 700), (0, 0, 0, 0))
        ImageDraw.Draw(g).ellipse((120, 120, 580, 580), fill=(253, 224, 71, int(170 * lid)))
        f.alpha_composite(g.filter(ImageFilter.GaussianBlur(60)), (int(cx - 350), int(cy - 420)))
        d = ImageDraw.Draw(f, "RGBA")
    d.rounded_rectangle((cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2), int(16 * s), fill=(168, 85, 247), outline=INK, width=6)
    d.rectangle((cx - 22 * s, cy - h / 2, cx + 22 * s, cy + h / 2), fill=(253, 224, 71), outline=INK, width=4)
    ly = cy - h / 2 - 30 * s - eb.ease(lid) * 190
    rot = lid * 25
    lw = w * 1.12
    d.rounded_rectangle((cx - lw / 2 + rot * 3, ly, cx + lw / 2 + rot * 3, ly + 54 * s), int(14 * s), fill=(192, 132, 252), outline=INK, width=6)
    d.rectangle((cx - 22 * s + rot * 3, ly, cx + 22 * s + rot * 3, ly + 54 * s), fill=(253, 224, 71), outline=INK, width=4)
    for side in (-1, 1):
        bx = cx + rot * 3 + side * 50 * s
        d.ellipse((bx - 48 * s, ly - 50 * s, bx + 48 * s, ly + 6 * s), outline=(253, 224, 71), width=int(16 * s))


def scene_invite(f, lt, D, t, buddy, lv, sp):
    d = ImageDraw.Draw(f, "RGBA")
    d.rectangle((0, GROUND, W, H), fill=(74, 222, 128))
    pop_text(d, (W / 2, 250), "Invite a friend", 100, (255, 255, 255), (lt - 0.1) / 0.4)
    pop_text(d, (W / 2, 380), "You BOTH get 1,000 XP!", 78, (253, 224, 71), (lt - 0.5) / 0.4, stroke=8)
    # paper plane from boy to girl
    p = clamp((lt - 0.6) / 1.1)
    a0, a1 = (300, 900), (780, 900)
    if 0 < p < 1:
        pts = []
        for j in range(int(p * 30)):
            q = j / 30
            pts.append((lerp(a0[0], a1[0], q), lerp(a0[1], a1[1], q) - math.sin(q * math.pi) * 380))
        for j in range(0, len(pts) - 1, 2):
            d.line(pts[j] + pts[j + 1], fill=(255, 255, 255, 200), width=6)
        x, y = lerp(a0[0], a1[0], p), lerp(a0[1], a1[1], p) - math.sin(p * math.pi) * 380
        ang = math.atan2(-math.cos(p * math.pi) * 380 * math.pi, a1[0] - a0[0])
        plane(d, x, y, ang, 1.6)
    gp = (lt - 1.6) / 0.45
    if gp > 0:
        lid = clamp((lt - 2.2) / 0.5)
        gift(f, W / 2, 880, gp, lid, t)
        if lid > 0.3:
            sparkles(f, W / 2, 760, t, spread=260, n=12)
            for k in range(8):
                q = clamp((lt - 2.3 - k * 0.04) / 0.8)
                if 0 < q < 1:
                    side = -1 if k % 2 else 1
                    coin(ImageDraw.Draw(f), W / 2 + side * q * (230 + 25 * (k // 2)), 760 - math.sin(q * math.pi) * 330 + q * 200, 30, t, k)
    for k, kind in enumerate(("boy", "girl")):
        cheer = lt > 2.7
        hop = abs(math.sin(lt * 5 + k * 1.4)) * 50 if cheer else 0
        draw_kid(f, kind, 200 if k == 0 else W - 200, GROUND + 80 - hop, t, cheer=cheer, arm=(0.5 + 0.5 * math.sin(t * 8 + k)) if cheer else (0.8 if (k == 0 and lt < 1.0) else 0.0))
        burst(f, 200 if k == 0 else W - 200, 640, 130, "+1,000 XP", (239, 68, 68) if k == 0 else (59, 130, 246), (lt - 2.7 - k * 0.15) / 0.4)
    hop = abs(math.sin(lt * 3.2)) * 25
    buddy.draw(f, W / 2, GROUND + 95 - hop, t, lv, scale=0.55)


def scene_grow(f, lt, D, t, buddy, lv, sp):
    g = clamp(lt / max(1.0, D * 0.7))
    f.alpha_composite(gradient(cs.mixc((148, 163, 184), (125, 211, 252), g), cs.mixc((203, 213, 225), (224, 242, 254), g), GROUND + 60))
    d = ImageDraw.Draw(f, "RGBA")
    cs.sun(d, 940, 700 - 60 * eb.ease(g), 85, t, angry=0.0)
    cs.cloud(d, 60 + lt * 25, 420, 0.9)
    cs.hills(d, cs.mixc((163, 163, 128), (134, 239, 172), g), cs.mixc((140, 140, 110), (74, 222, 128), g))
    for k, x in enumerate((130, 360, 720, 950)):
        cs.plant(d, x, GROUND + 40 + (k % 2) * 30, clamp((lt - 0.3 - k * 0.35) / 1.4), t + k)
    for k in range(10):  # hearts and leaves rising
        ph = (lt * 0.5 + k * 0.13) % 1.0
        x = 120 + k * 95 + math.sin(t * 2 + k) * 25
        y = GROUND - ph * 900
        a = int(230 * math.sin(ph * math.pi) * clamp(lt - 0.6))
        if k % 2:
            d.ellipse((x - 22, y - 10, x + 22, y + 10), fill=(34, 197, 94, a))
        else:
            d.ellipse((x - 18, y - 16, x, y + 2), fill=(244, 63, 94, a))
            d.ellipse((x, y - 16, x + 18, y + 2), fill=(244, 63, 94, a))
            d.polygon([(x - 18, y - 6), (x + 18, y - 6), (x, y + 18)], fill=(244, 63, 94, a))
    pop_text(d, (W / 2, 280), "Every gesture", 100, (255, 255, 255), (lt - 0.2) / 0.4)
    pop_text(d, (W / 2, 410), "COUNTS!", 150, (253, 224, 71), (lt - 0.6) / 0.4, stroke=11)
    pop_text(d, (W / 2, 560), "Now in your pocket", 62, (21, 128, 61), (lt - 1.4) / 0.4, stroke=0)
    hop = abs(math.sin(lt * 3)) * 30
    buddy.draw(f, W / 2, GROUND + 90 - hop, t, lv, scale=0.8)


def scene_party(f, lt, D, t, buddy, lv, sp):
    f.alpha_composite(gradient((129, 140, 248), (244, 114, 182), GROUND + 50))
    d = ImageDraw.Draw(f, "RGBA")
    d.rectangle((0, GROUND, W, H), fill=(74, 222, 128))
    for row, y0 in enumerate((170, 290)):
        for k in range(10):
            x = k * 120 + (60 if row else 0)
            yy = y0 + 30 * math.sin(k / 9 * math.pi) + 6 * math.sin(t * 3 + k)
            col = [(239, 68, 68), (250, 204, 21), (34, 197, 94), (59, 130, 246)][(k + row) % 4]
            d.polygon([(x, yy), (x + 110, yy), (x + 55, yy + 90)], fill=col, outline=INK, width=3)
    for x, delay, col in cs.BALL:
        y = H + 100 - ((lt + delay) * 260) % (H + 300)
        d.line((x, y + 80, x + 10 * math.sin(t * 3 + x), y + 220), fill=(80, 80, 80), width=3)
        d.ellipse((x - 55, y - 70, x + 55, y + 80), fill=col, outline=INK, width=4)
        d.ellipse((x - 30, y - 45, x - 12, y - 15), fill=(255, 255, 255, 180))
    pop_text(d, (W / 2, 490), "WE'RE LIVE", 150, (253, 224, 71), (lt - 0.15) / 0.45, stroke=11)
    pop_text(d, (W / 2, 640), "ON iOS!", 150, (255, 255, 255), (lt - 0.45) / 0.45, stroke=11)
    pop_text(d, (W / 2, 775), "Who's your first invite?", 66, (255, 255, 255), (lt - 1.2) / 0.4, stroke=7)
    for k, kind in enumerate(("boy", "girl")):
        hop = abs(math.sin(lt * 5 + k * 1.5)) * 60
        draw_kid(f, kind, 200 if k == 0 else W - 200, GROUND + 80 - hop, t, scale=0.85, cheer=True, arm=0.5 + 0.5 * math.sin(t * 8 + k))
    hop = abs(math.sin(lt * 4.5 + 0.7)) * 60
    buddy.draw(f, W / 2, GROUND + 70 - hop, t, lv, scale=0.8)
    for x, y0, sp_, col, ph in cs.CONF:
        y = (y0 + sp_ * lt) % (H + 100)
        x2 = x + math.sin(t * 2 + ph) * 30
        a = t * 5 + ph
        d.polygon([(x2 + math.cos(a) * 14, y + math.sin(a) * 6), (x2 - math.sin(a) * 6, y + math.cos(a) * 14), (x2 - math.cos(a) * 14, y - math.sin(a) * 6), (x2 + math.sin(a) * 6, y - math.cos(a) * 14)], fill=col)


cs.STORIES["ios-launch"] = (
    [scene_title, scene_rocket, scene_quiz, scene_invite, scene_grow, scene_party, cs.scene_cta],
    [0.4, 1.2, 1.3, 1.8, 0.6, 0.6, 1.4],
    [NIGHT, SPACE, cs.SKY, ((244, 114, 182), (253, 186, 116)), None, None, None],
)

if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as fh:
        spec = json.load(fh)
    spec["story"] = "ios-launch"
    cs.render(spec)
