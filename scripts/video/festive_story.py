"""Animated festive greeting story (1080x1920, 9:16) for Instagram Stories / WhatsApp Status.

Usage: python festive_story.py spec.json
Spec:
  ffmpeg, out, music, logo, partnerLogo, mascot
  title1, title2   e.g. "Happy" / "Dhanteras"
  wish             line under the title
  closing          line that replaces the wish near the end
  from_line        small text above the logo card
  seconds          length (default 15)

Night sky, fireworks, a swaying marigold garland, a slowly turning rangoli
behind Earth Buddy, diyas that light up one by one, and falling gold sparkles.
Pillow draws every frame and pipes it to ffmpeg.
"""
import json, math, os, random, subprocess, sys
from PIL import Image, ImageDraw, ImageFilter, ImageChops

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import earth_buddy as eb  # noqa: E402  (fonts, easing, mascot cut-out, logo bar)

W, H, FPS = 1080, 1920, 30
F = r"C:\Windows\Fonts"
SCRIPT = os.path.join(F, "Gabriola.ttf")
SERIF = os.path.join(F, "georgiab.ttf")
GOLD_TOP, GOLD_BOT = (255, 236, 160), (214, 140, 20)
CREAM = (255, 244, 222)


def clamp(t):
    return max(0.0, min(1.0, t))


# ------------------------------------------------------------- sprites

def glow_sprite(r, color, strength=1.0):
    s = r * 4
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.ellipse((s / 2 - r, s / 2 - r, s / 2 + r, s / 2 + r), fill=color + (int(200 * strength),))
    return im.filter(ImageFilter.GaussianBlur(r * 0.7))


def background():
    bg = Image.new("RGB", (W, H))
    top, mid, bot = (14, 8, 40), (48, 14, 58), (92, 22, 30)
    d = ImageDraw.Draw(bg)
    for y in range(H):
        t = y / H
        c = [int(top[i] + (mid[i] - top[i]) * t * 2) for i in range(3)] if t < 0.5 else [int(mid[i] + (bot[i] - mid[i]) * (t - 0.5) * 2) for i in range(3)]
        d.line((0, y, W, y), fill=tuple(c))
    # warm glow rising from the diyas
    g = glow_sprite(420, (255, 140, 40), 0.55).resize((1500, 900))
    bg.paste(g, ((W - 1500) // 2, 1000), g)
    return bg


def rangoli(size):
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    c = size / 2
    rings = [(0.48, 16, (236, 72, 153)), (0.40, 12, (250, 204, 21)), (0.31, 10, (34, 197, 94)), (0.22, 8, (249, 115, 22)), (0.13, 6, (56, 189, 248))]
    for frac, n, col in rings:
        r = size * frac
        pr = r * 0.32
        for k in range(n):
            a = 2 * math.pi * k / n
            x, y = c + math.cos(a) * (r - pr), c + math.sin(a) * (r - pr)
            # petal: ellipse pointing outward
            pet = Image.new("RGBA", (int(pr * 2), int(pr * 2)), (0, 0, 0, 0))
            ImageDraw.Draw(pet).ellipse((pr * 0.55, 0, pr * 1.45, pr * 2), fill=col + (215,), outline=(255, 250, 235, 230), width=3)
            pet = pet.rotate(-math.degrees(a) - 90, resample=Image.BICUBIC, expand=True)
            im.alpha_composite(pet, (int(x - pet.width / 2), int(y - pet.height / 2)))
        d.ellipse((c - r, c - r, c + r, c + r), outline=(255, 245, 220, 120), width=3)
        for k in range(n * 2):
            a = 2 * math.pi * (k + 0.5) / (n * 2)
            x, y = c + math.cos(a) * r, c + math.sin(a) * r
            d.ellipse((x - 6, y - 6, x + 6, y + 6), fill=(255, 250, 235, 230))
    d.ellipse((c - 26, c - 26, c + 26, c + 26), fill=(250, 204, 21, 255))
    return im


def diya_sprite(w=120):
    h = int(w * 0.55)
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.chord((0, -h, w - 1, h - 1), 0, 180, fill=(176, 74, 28), outline=(120, 45, 15), width=3)
    d.ellipse((4, 0, w - 5, int(h * 0.38)), fill=(130, 50, 18), outline=(222, 120, 50), width=3)
    for k in range(5):  # little painted dots
        x = w * (0.2 + 0.15 * k)
        d.ellipse((x - 5, h * 0.6 - 5, x + 5, h * 0.6 + 5), fill=(250, 204, 21))
    return im


def flame(scale, t, seed):
    fw, fh = int(34 * scale), int(70 * scale)
    if fw < 2 or fh < 2:
        return None
    im = Image.new("RGBA", (fw * 3, fh * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    sway = math.sin(t * 9 + seed) * fw * 0.12
    cx, base = fw * 1.5, fh * 1.8
    pts = [(cx - fw / 2, base - fh * 0.25), (cx + sway, base - fh), (cx + fw / 2, base - fh * 0.25), (cx, base)]
    d.polygon(pts, fill=(255, 170, 30, 255))
    d.ellipse((cx - fw / 2, base - fh * 0.5, cx + fw / 2, base), fill=(255, 170, 30, 255))
    inner = [(cx - fw / 4, base - fh * 0.2), (cx + sway * 0.6, base - fh * 0.65), (cx + fw / 4, base - fh * 0.2), (cx, base - 2)]
    d.polygon(inner, fill=(255, 245, 190, 255))
    return im


def sparkle(d, x, y, r, a):
    col = (255, 230, 150, int(255 * a))
    d.polygon([(x, y - r), (x + r * 0.25, y - r * 0.25), (x + r, y), (x + r * 0.25, y + r * 0.25), (x, y + r), (x - r * 0.25, y + r * 0.25), (x - r, y), (x - r * 0.25, y - r * 0.25)], fill=col)


def gold_text(text, path, size, shine_x=None):
    fnt = eb.font(path, size)
    tmp = ImageDraw.Draw(Image.new("L", (1, 1)))
    l, t, r, b = tmp.textbbox((0, 0), text, font=fnt)
    w, h = r - l + 20, b - t + 20
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).text((10 - l, 10 - t), text, font=fnt, fill=255)
    grad = Image.new("RGB", (w, h))
    gd = ImageDraw.Draw(grad)
    for y in range(h):
        k = y / h
        gd.line((0, y, w, y), fill=tuple(int(GOLD_TOP[i] + (GOLD_BOT[i] - GOLD_TOP[i]) * k) for i in range(3)))
    if shine_x is not None:
        band = Image.new("L", (w, h), 0)
        bd = ImageDraw.Draw(band)
        x = shine_x * (w + 300) - 150
        bd.polygon([(x - 40, 0), (x + 40, 0), (x - 40, h), (x - 120, h)], fill=200)
        band = band.filter(ImageFilter.GaussianBlur(12))
        grad = Image.composite(Image.new("RGB", (w, h), (255, 255, 240)), grad, band)
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    out.paste(grad, (0, 0), mask)
    shadow = Image.new("RGBA", (w + 40, h + 40), (0, 0, 0, 0))
    sm = Image.new("L", (w + 40, h + 40), 0)
    sm.paste(mask, (20, 26))
    shadow.putalpha(sm.filter(ImageFilter.GaussianBlur(10)).point(lambda v: v * 0.7))
    shadow.alpha_composite(out, (20, 20))
    return shadow


def text_img(text, path, size, fill, max_w=W - 140, stroke=0):
    tmp = ImageDraw.Draw(Image.new("L", (1, 1)))
    f, lines = eb.fit_lines(tmp, text, path, size, max_w, 3)
    lh = int(f.size * 1.25)
    im = Image.new("RGBA", (W, lh * len(lines) + 20), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    for i, ln in enumerate(lines):
        d.text((W / 2, 10 + i * lh), ln, font=f, fill=fill, anchor="ma", stroke_width=stroke, stroke_fill=(40, 10, 30))
    return im


def scaled(im, s, alpha=1.0):
    if s <= 0.01 or alpha <= 0.01:
        return None
    out = im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))), Image.LANCZOS) if abs(s - 1) > 0.005 else im.copy()
    if alpha < 0.999:
        a = out.getchannel("A").point(lambda v: int(v * alpha))
        out.putalpha(a)
    return out


def put_at(frame, im, x, y):
    if im is not None:
        frame.alpha_composite(im, (int(x), int(y)))


def put_center(frame, im, cx, cy):
    if im is not None:
        frame.alpha_composite(im, (int(cx - im.width / 2), int(cy - im.height / 2)))


# ------------------------------------------------------------- fireworks

COLORS = [(255, 214, 90), (255, 120, 160), (120, 220, 255), (170, 255, 150), (255, 160, 70), (230, 170, 255)]


def make_bursts(seconds, rnd):
    bursts, t = [], 0.2
    while t < seconds - 0.8:
        side = rnd.choice([0, 1, 2])
        x = rnd.uniform(140, 360) if side == 0 else rnd.uniform(720, 940) if side == 1 else rnd.uniform(300, 780)
        y = rnd.uniform(160, 720)
        n = rnd.randint(26, 40)
        speed = rnd.uniform(240, 360)
        parts = [(2 * math.pi * k / n + rnd.uniform(-0.08, 0.08), speed * rnd.uniform(0.75, 1.05)) for k in range(n)]
        bursts.append({"t": t, "x": x, "y": y, "c": rnd.choice(COLORS), "p": parts})
        t += rnd.uniform(0.45, 0.95)
    return bursts


def draw_bursts(frame, bursts, tt, glows):
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for b in bursts:
        age = tt - b["t"]
        if age < -0.45 or age > 1.6:
            continue
        if age < 0:  # rocket trail rising
            k = 1 + age / 0.45
            y = H * 0.75 + (b["y"] - H * 0.75) * eb.ease(k)
            d.line((b["x"], y, b["x"], y + 60), fill=b["c"] + (int(160 * k),), width=4)
            continue
        fade = clamp(1 - age / 1.6)
        if age < 0.25:
            g = glows[b["c"]]
            gg = scaled(g, 0.6 + age * 3, (1 - age / 0.25) * 0.9)
            put_center(layer, gg, b["x"], b["y"])
        for ang, sp in b["p"]:
            dist = sp * (1 - math.exp(-age * 2.6)) / 1.0
            x = b["x"] + math.cos(ang) * dist
            y = b["y"] + math.sin(ang) * dist + 70 * age * age
            r = 5 * fade + 1
            d.ellipse((x - r, y - r, x + r, y + r), fill=b["c"] + (int(255 * fade),))
            tx = b["x"] + math.cos(ang) * dist * 0.82
            ty = b["y"] + math.sin(ang) * dist * 0.82 + 70 * age * age * 0.8
            d.line((tx, ty, x, y), fill=b["c"] + (int(120 * fade),), width=2)
    frame.alpha_composite(layer)


# ------------------------------------------------------------- garland

def draw_garland(d, tt):
    sway = math.sin(tt * 1.6) * 10
    for row, (y0, sag, col) in enumerate([(-10, 170, (249, 115, 22)), (-20, 110, (250, 204, 21))]):
        n = 34
        for k in range(n + 1):
            u = k / n
            x = u * W
            y = y0 + sag * 4 * u * (1 - u) + sway * math.sin(math.pi * u)
            r = 22 if row == 0 else 18
            d.ellipse((x - r, y - r, x + r, y + r), fill=col, outline=(200, 80, 10) if row == 0 else (190, 140, 10), width=3)
        if row == 0:  # hanging tassels
            for k in range(1, 8):
                u = k / 8
                x = u * W
                y = y0 + sag * 4 * u * (1 - u) + sway * math.sin(math.pi * u)
                for j in range(1, 4):
                    yy = y + j * 30
                    c2 = (250, 204, 21) if j % 2 else (249, 115, 22)
                    d.ellipse((x - 13, yy - 13, x + 13, yy + 13), fill=c2)
                d.polygon([(x - 10, y + 115), (x + 10, y + 115), (x, y + 140)], fill=(34, 197, 94))


# ------------------------------------------------------------- render

def render(spec):
    seconds = float(spec.get("seconds", 15))
    n_frames = int(seconds * FPS)
    rnd = random.Random(spec.get("seed", 7))
    bg = background().convert("RGBA")
    stars = [(rnd.uniform(0, W), rnd.uniform(0, H * 0.55), rnd.uniform(1, 3), rnd.uniform(0, 6.28)) for _ in range(110)]
    glows = {c: glow_sprite(80, c) for c in COLORS}
    flame_glow = glow_sprite(70, (255, 170, 50), 0.9)
    rang = rangoli(700)
    diya = diya_sprite(124)
    mascot = eb.cutout(spec["mascot"])
    bb = mascot.getbbox()
    mascot = mascot.crop(bb)
    mh = 500
    mascot = mascot.resize((int(mascot.width * mh / mascot.height), mh), Image.LANCZOS)
    logo_card = eb.logo_bar(spec)
    t_happy = text_img(spec.get("title1", "Happy"), SCRIPT, 190, CREAM)
    wish = text_img(spec["wish"], eb.FS, 48, CREAM)
    closing = text_img(spec["closing"], eb.FB, 54, (255, 226, 140))
    from_line = text_img(spec["from_line"], eb.FS, 38, CREAM)
    falling = [(rnd.uniform(0, W), rnd.uniform(-H, H), rnd.uniform(60, 160), rnd.uniform(6, 16), rnd.uniform(0, 6.28)) for _ in range(46)]
    bursts = make_bursts(seconds, rnd)
    diya_x = [W / 2 + (k - 3) * 140 for k in range(7)]
    DIYA_Y = 1345

    out = spec["out"]
    silent = out + ".silent.mp4"
    preview = {int(t * FPS) for t in spec.get("preview", [])}
    ff = None if preview else subprocess.Popen([spec["ffmpeg"], "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                           "-c:v", "libx264", "-preset", "slow", "-tune", "animation", "-crf", "16", "-profile:v", "high", "-g", "60", "-pix_fmt", "yuv420p", silent], stdin=subprocess.PIPE)
    for fi in range(n_frames):
        tt = fi / FPS
        frame = bg.copy()
        d = ImageDraw.Draw(frame)
        for x, y, r, ph in stars:
            a = 0.35 + 0.65 * (0.5 + 0.5 * math.sin(tt * 2.5 + ph))
            d.ellipse((x - r, y - r, x + r, y + r), fill=(255, 250, 230, int(220 * a)))
        draw_bursts(frame, bursts, tt, glows)

        # rangoli (behind mascot), blooms in then turns slowly
        rs = eb.ease((tt - 3.6) / 1.0)
        if rs > 0:
            rimg = rang.rotate(tt * 12, resample=Image.BICUBIC)
            put_center(frame, scaled(rimg, rs * 0.94, 0.85), W / 2, 1135)

        # mascot pops in with a gentle bob
        ms = (tt - 4.3) / 0.6
        if ms > 0:
            s = eb.pop(ms) if ms < 1 else 1.0
            bob = math.sin(tt * 3) * 10
            m = scaled(mascot, s)
            if m is not None:
                frame.alpha_composite(m, (int(W / 2 - m.width / 2), int(1335 - m.height + bob)))

        # diyas light up one by one
        for k, x in enumerate(diya_x):
            appear = eb.ease((tt - 0.2 - k * 0.12) / 0.4)
            if appear <= 0:
                continue
            y = DIYA_Y + (1 - appear) * 80
            lit = (tt - 1.0 - k * 0.22) / 0.3
            if lit > 0:
                flick = 0.85 + 0.15 * math.sin(tt * 13 + k * 1.7) + 0.05 * math.sin(tt * 29 + k)
                g = scaled(flame_glow, min(1, lit) * flick * 1.1, min(1, lit) * 0.85)
                put_center(frame, g, x, y - 34)
                fl = flame(min(1, lit) * flick, tt, k)
                if fl:
                    frame.alpha_composite(fl, (int(x - fl.width / 2), int(y - fl.height * 0.9 + 6)))
            dd = scaled(diya, 1.0, appear)
            if dd is not None:
                frame.alpha_composite(dd, (int(x - dd.width / 2), int(y)))

        # falling gold sparkles (more after the title lands)
        sd = ImageDraw.Draw(frame)
        dens = clamp((tt - 1.0) / 1.0)
        for i, (x0, y0, sp, r, ph) in enumerate(falling):
            if i / len(falling) > 0.3 + 0.7 * dens:
                continue
            y = (y0 + sp * tt) % (H + 100) - 50
            x = x0 + math.sin(tt * 1.5 + ph) * 26
            a = 0.5 + 0.5 * math.sin(tt * 6 + ph)
            sparkle(sd, x, y, r * (0.6 + 0.4 * a), 0.4 + 0.6 * a)

        draw_garland(ImageDraw.Draw(frame), tt)

        # title
        hs = (tt - 0.6) / 0.5
        if hs > 0:
            put_center(frame, scaled(t_happy, eb.pop(hs) if hs < 1 else 1, clamp(hs * 2)), W / 2, 395)
        ds = (tt - 1.1) / 0.55
        if ds > 0:
            shine = ((tt - 1.8) % 3.2) / 1.0 if tt > 1.8 else None
            gt = gold_text(spec.get("title2", "Dhanteras"), SERIF, 166, shine if shine is not None and shine <= 1 else None)
            put_center(frame, scaled(gt, eb.pop(ds) if ds < 1 else 1, clamp(ds * 2)), W / 2, 585)

        # wish, then the closing line
        ws = clamp((tt - 2.4) / 0.6)
        wo = clamp((tt - (seconds - 4.6)) / 0.4)
        if ws > 0 and wo < 1:
            put_at(frame, scaled(wish, 1, ws * (1 - wo)), 0, 712 + (1 - eb.ease(ws)) * 30)
        cs = (tt - (seconds - 4.2)) / 0.5
        if cs > 0:
            put_center(frame, scaled(closing, eb.pop(cs) if cs < 1 else 1, clamp(cs * 2)), W / 2, 770)

        # "from the team" + logos
        ls = (tt - 5.4) / 0.6
        if ls > 0:
            a = clamp(ls * 2)
            put_at(frame, scaled(from_line, 1, a), 0, 1440 + (1 - eb.ease(ls)) * 40)
            card = scaled(logo_card, eb.pop(ls) if ls < 1 else 1, a)
            put_center(frame, card, W / 2, 1585 + (1 - eb.ease(ls)) * 40)

        # fade in from black / gentle fade at the end
        fade = min(clamp(tt / 0.4), clamp((seconds - tt) / 0.5))
        if fade < 1:
            frame = Image.blend(Image.new("RGBA", (W, H), (0, 0, 0, 255)), frame, fade)
        if preview:
            if fi in preview:
                frame.convert("RGB").resize((360, 640)).save(f"{out}.p{fi}.jpg")
            continue
        ff.stdin.write(frame.convert("RGB").tobytes())
    if preview:
        return
    ff.stdin.close()
    ff.wait()

    music = spec.get("music")
    if music and os.path.exists(music):
        subprocess.run([spec["ffmpeg"], "-y", "-loglevel", "error", "-i", silent, "-i", music, "-filter_complex",
                        f"[1:a]volume=0.9,afade=t=in:d=0.6,afade=t=out:st={seconds - 1.5:.2f}:d=1.5,atrim=0:{seconds:.2f}[a]",
                        "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", out], check=True)
        os.remove(silent)
    else:
        os.replace(silent, out)
    print(json.dumps({"file": out, "seconds": seconds}))


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as fh:
        render(json.load(fh))
