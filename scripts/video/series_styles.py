"""Panels and sound effects for the video series styles in earth_buddy.py.

Styles:
  news  - a climate-news bulletin: dark studio, red CLIMATE NEWS tag with a
          live dot, headline card with source and date, "what it means" and
          "what you can do" cards, a scrolling ticker and word-by-word captions.
  quiz  - a question with options A/B/C, a 3-2-1 countdown ring, then the
          answer revealed in green with confetti.
  myth  - a red MYTH stamp slams onto the claim, then a green FACT stamp.
  hack  - numbered steps that spin in, a step counter and a tick per step,
          then a result card with sparkles.

Scene kinds used by these styles (other kinds fall back to the normal cards):
  headline (news), point/action (news), quiz, answer, myth, fact, step, payoff.

Sound effects are made with ffmpeg's tone/noise generators, so no audio files
are needed.
"""
import math, os, random, subprocess
from PIL import Image, ImageDraw, ImageFilter

import earth_buddy as eb

W, H = eb.W, eb.H
RED, GREEN, AMBER = (220, 38, 38), (22, 163, 74), (234, 179, 8)
NAVY_TOP, NAVY_BOT = (8, 15, 35), (22, 44, 96)
INK = eb.CARD_INK

SERIES_STYLES = ("news", "quiz", "myth", "hack")
PANEL_KINDS = {
    "news": ("headline", "point", "action", "question"),
    "quiz": ("quiz", "answer"),
    "myth": ("myth", "fact"),
    "hack": ("step", "payoff"),
}


def clamp(t):
    return max(0.0, min(1.0, t))


# ---------------------------------------------------------------- shared bits

def tick_mark(d, cx, cy, size, p, color=GREEN, width=16):
    """A tick that draws itself as p goes 0..1."""
    a = (cx - size * 0.5, cy)
    b = (cx - size * 0.12, cy + size * 0.38)
    c = (cx + size * 0.55, cy - size * 0.4)
    p = clamp(p)
    if p <= 0:
        return
    if p < 0.4:
        k = p / 0.4
        d.line([a, (a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k)], fill=color, width=width, joint="curve")
    else:
        k = (p - 0.4) / 0.6
        d.line([a, b, (b[0] + (c[0] - b[0]) * k, b[1] + (c[1] - b[1]) * k)], fill=color, width=width, joint="curve")


def cross_mark(d, cx, cy, size, p, color=RED, width=16):
    p = clamp(p)
    s = size / 2
    if p > 0:
        k = clamp(p / 0.5)
        d.line([(cx - s, cy - s), (cx - s + 2 * s * k, cy - s + 2 * s * k)], fill=color, width=width)
    if p > 0.5:
        k = clamp((p - 0.5) / 0.5)
        d.line([(cx + s, cy - s), (cx + s - 2 * s * k, cy - s + 2 * s * k)], fill=color, width=width)


def circle_badge(d, cx, cy, r, fill, outline=None):
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=fill, outline=outline, width=6 if outline else 0)


def stamp(text, color, size=92):
    """A rotated rubber-stamp label."""
    f = eb.font(eb.FX, size)
    tmp = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    tw = int(tmp.textlength(text, font=f))
    im = Image.new("RGBA", (tw + 90, size + 70), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((6, 6, im.width - 6, im.height - 6), 22, outline=color + (255,), width=10)
    d.text((im.width / 2, im.height / 2 + 2), text, font=f, fill=color + (255,), anchor="mm")
    return im.rotate(-8, expand=True, resample=Image.BICUBIC)


def confetti(frame, t, seed=3, n=46, origin=(W // 2, 640)):
    """Burst of confetti that falls; t = seconds since the burst."""
    if t < 0 or t > 2.4:
        return
    r = random.Random(seed)
    d = ImageDraw.Draw(frame)
    cols = [GREEN, AMBER, (59, 130, 246), (236, 72, 153), (255, 255, 255), RED]
    for i in range(n):
        ang = r.uniform(-math.pi, 0)
        sp = r.uniform(700, 1500)
        vx, vy = math.cos(ang) * sp, math.sin(ang) * sp
        x = origin[0] + vx * t * 0.6
        y = origin[1] + vy * t * 0.6 + 900 * t * t
        if y > H:
            continue
        s = r.uniform(10, 20)
        rot = t * r.uniform(4, 10) + i
        dx, dy = s * math.cos(rot), s * 0.45 * math.sin(rot)
        d.polygon([(x - dx, y - dy), (x + dy, y - dx), (x + dx, y + dy), (x - dy, y + dx)], fill=cols[i % len(cols)])


def sparkles(frame, t, cx, cy, spread=330, n=10, flat=0.6):
    d = ImageDraw.Draw(frame)
    r = random.Random(11)
    for i in range(n):
        ang = 2 * math.pi * i / n + r.uniform(-0.2, 0.2)
        dist = spread * (0.55 + 0.45 * r.random())
        ph = (t * 1.6 + r.random()) % 1.0
        s = 26 * math.sin(math.pi * ph)
        if s <= 1:
            continue
        x, y = cx + math.cos(ang) * dist, cy + math.sin(ang) * dist * flat
        d.polygon([(x, y - s), (x + s * 0.28, y - s * 0.28), (x + s, y), (x + s * 0.28, y + s * 0.28), (x, y + s), (x - s * 0.28, y + s * 0.28), (x - s, y), (x - s * 0.28, y - s * 0.28)], fill=AMBER)


def shake(t, strength=14):
    """Screen shake offset for a stamp landing (t = seconds since it landed)."""
    if t < 0 or t > 0.3:
        return 0, 0
    k = (1 - t / 0.3) * strength
    return int(k * math.sin(t * 90)), int(k * math.cos(t * 70))


def words_frac(words, local):
    """Share of the scene's spoken words said by `local` seconds (word timings from edge-tts)."""
    if not words:
        return None
    said = sum(1 for (s, _e, _w) in words if s <= local)
    return said / len(words)


# ---------------------------------------------------------------- news

def news_bg(seed=0):
    bg = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(bg)
    for y in range(H):
        d.line([(0, y), (W, y)], fill=eb.mix(NAVY_TOP, NAVY_BOT, y / H))
    # A faint dotted globe behind the cards.
    glow = Image.new("L", (W, H), 0)
    gd = ImageDraw.Draw(glow)
    cx, cy, r = W // 2, 820, 620
    for lat in range(-80, 81, 10):
        for lon in range(0, 360, 8):
            la, lo = math.radians(lat), math.radians(lon + seed * 7)
            x, z = math.cos(la) * math.sin(lo), math.cos(la) * math.cos(lo)
            if z < 0:
                continue
            px, py = cx + r * x, cy - r * math.sin(la)
            gd.ellipse((px - 3, py - 3, px + 3, py + 3), fill=int(40 + 60 * z))
    bg.paste(Image.new("RGB", (W, H), (96, 165, 250)), (0, 0), glow.filter(ImageFilter.GaussianBlur(1)))
    return bg


def news_tag(frame, tt, label="CLIMATE NEWS", y=262):
    d = ImageDraw.Draw(frame)
    f = eb.font(eb.FX, 44)
    tw = d.textlength(label, font=f)
    x0 = 60
    d.rounded_rectangle((x0, y, x0 + tw + 120, y + 78), 14, fill=RED)
    pulse = 0.5 + 0.5 * math.sin(tt * 6)
    r = 12 + 4 * pulse
    d.ellipse((x0 + 40 - r, y + 39 - r, x0 + 40 + r, y + 39 + r), fill=(255, 255, 255))
    d.text((x0 + 75, y + 39), label, font=f, fill=(255, 255, 255), anchor="lm")


def ticker(frame, text, tt, y=H - 96):
    band = Image.new("RGBA", (W, 96), (220, 38, 38, 255))
    d = ImageDraw.Draw(band)
    f = eb.font(eb.FB, 42)
    msg = f"  {text}   •   EVERY SUSTAINABLE GESTURE COUNTS   • "
    tw = d.textlength(msg, font=f)
    x = -((tt * 220) % tw)
    while x < W:
        d.text((x, 48), msg, font=f, fill=(255, 255, 255), anchor="lm")
        x += tw
    frame.paste(band, (0, y), band)


def news_panel(scene, spec, local, dur, frac, idx):
    kind = scene.get("kind")
    w, h = W - 120, 640
    c = eb.white_card(w, h, radius=28)
    d = ImageDraw.Draw(c)
    cx = w // 2
    if kind == "headline":
        d.rounded_rectangle((0, 0, w - 1, 22), 10, fill=RED)
        meta = " · ".join(x for x in [scene.get("source", ""), scene.get("date", "")] if x)
        if meta:
            d.text((50, 60), meta.upper(), font=eb.font(eb.FB, 34), fill=(100, 116, 139))
        text = scene.get("big") or scene["text"]
        hf, lines = eb.fit_lines(d, text, eb.FX, 74, w - 100, 6, min_size=44)
        words_all = text.split()
        shown = max(1, math.ceil(len(words_all) * clamp((frac if frac is not None else local / max(0.1, dur)) * 1.15)))
        count, y = 0, 130
        for ln in lines:
            ws = ln.split()
            x = 50
            for wd in ws:
                if count < shown:
                    d.text((x, y), wd, font=hf, fill=INK)
                x += d.textlength(wd + " ", font=hf)
                count += 1
            y += hf.size + 14
        sweep = clamp(local / 0.8)
        d.rectangle((50, y + 16, 50 + (w - 100) * sweep, y + 24), fill=RED)
    else:
        label = {"point": "WHAT IT MEANS", "action": "WHAT YOU CAN DO", "question": "YOUR TAKE?"}.get(kind, "")
        col = {"point": (37, 99, 235), "action": GREEN, "question": AMBER}.get(kind, (37, 99, 235))
        d.rounded_rectangle((0, 0, 16, h - 1), 8, fill=col)
        lf = eb.font(eb.FB, 40)
        lw = d.textlength(label, font=lf)
        d.rounded_rectangle((50, 46, 50 + lw + 50, 46 + 70), 35, fill=col)
        d.text((75, 81), label, font=lf, fill=(255, 255, 255), anchor="lm")
        tf, lines = eb.fit_lines(d, scene.get("big") or scene["text"], eb.FB, 66, w - 120, 6, min_size=40)
        total = len(lines) * (tf.size + 14)
        y = 150 + max(0, (h - 150 - 60 - total) // 2)
        for ln in lines:
            d.text((60, y), ln, font=tf, fill=INK)
            y += tf.size + 14
        if kind == "action":
            tick_mark(d, w - 110, 85, 70, (local - 0.3) / 0.5, GREEN, 14)
    # Slide in from the right, a new card for each scene.
    slide = eb.ease(local / 0.4)
    return c, int((1 - slide) * (W + 40))


def caption_bar(frame, text, frac, y=1110, max_w=W - 360, x0=40):
    """Lower-third caption with the current word highlighted (for news)."""
    d = ImageDraw.Draw(frame)
    words = text.split()
    if not words:
        return
    f, lines = eb.fit_lines(d, text, eb.FB, 50, max_w - 60, 4, min_size=36)
    n = len(words)
    shown = max(1, math.ceil(n * clamp(frac)))
    lh = f.size + 12
    bh = 36 + lh * len(lines)
    d.rounded_rectangle((x0, y, x0 + max_w, y + bh), 26, fill=(15, 23, 42))
    k = 0
    for li, ln in enumerate(lines):
        x = x0 + 30
        for wd in ln.split():
            col = (255, 255, 255) if k < shown - 1 else (AMBER if k == shown - 1 else (100, 116, 139))
            d.text((x, y + 18 + li * lh), wd, font=f, fill=col)
            x += d.textlength(wd + " ", font=f)
            k += 1


# ---------------------------------------------------------------- quiz

def quiz_panel(scene, local, dur, hold, reveal):
    w, h = W - 120, 760
    c = eb.white_card(w, h, radius=40)
    d = ImageDraw.Draw(c)
    cx = w // 2
    q = scene.get("question") or scene["text"]
    qf, lines = eb.fit_lines(d, q, eb.FB, 60, w - 110, 3, min_size=40)
    y = 50
    for ln in lines:
        d.text((cx, y), ln, font=qf, fill=INK, anchor="ma")
        y += qf.size + 10
    y += 30
    opts = scene.get("options", [])[:3]
    ans = int(scene.get("answer", 0))
    row = 120
    for i, o in enumerate(opts):
        appear = clamp((local - (0.25 + 0.18 * i) * max(1.0, dur)) / 0.25) if not reveal else 1.0
        if appear <= 0:
            continue
        yy = y + i * (row + 18)
        off = int((1 - eb.ease(appear)) * 120)
        if reveal:
            good = i == ans
            fill = (220, 252, 231) if good else (241, 245, 249)
            edge = GREEN if good else (203, 213, 225)
        else:
            fill, edge = (248, 250, 252), (203, 213, 225)
        d.rounded_rectangle((40 + off, yy, w - 40 + off, yy + row), 30, fill=fill, outline=edge, width=5)
        letter = "ABC"[i]
        circle_badge(d, 110 + off, yy + row // 2, 38, edge if reveal else (37, 99, 235))
        d.text((110 + off, yy + row // 2), letter, font=eb.font(eb.FB, 40), fill=(255, 255, 255), anchor="mm")
        of, ol = eb.fit_lines(d, o, eb.FS, 46, w - 300, 2, min_size=32)
        ty = yy + (row - len(ol) * (of.size + 4)) // 2
        for ln in ol:
            d.text((175 + off, ty), ln, font=of, fill=INK if (not reveal or i == ans) else (148, 163, 184))
            ty += of.size + 4
        if reveal:
            pr = (local - 0.15) / 0.4
            if i == ans:
                tick_mark(d, w - 110, yy + row // 2, 60, pr, GREEN, 12)
            else:
                cross_mark(d, w - 110, yy + row // 2, 44, pr, (148, 163, 184), 9)
    if reveal and scene.get("explain"):
        ef, el = eb.fit_lines(d, scene["explain"], eb.FS, 40, w - 120, 2, min_size=30)
        ey = y + 3 * (row + 18) + 6
        for ln in el:
            d.text((cx, ey), ln, font=ef, fill=GREEN, anchor="ma")
            ey += ef.size + 6
    return c


def countdown(frame, cx, cy, remaining, total):
    """Ring timer with a big number."""
    d = ImageDraw.Draw(frame)
    r = 92
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(255, 255, 255), outline=(226, 232, 240), width=14)
    frac = clamp(remaining / max(0.1, total))
    if frac > 0:
        d.arc((cx - r, cy - r, cx + r, cy + r), -90, -90 + 360 * frac, fill=RED if remaining < 1.2 else AMBER, width=14)
    n = max(1, math.ceil(remaining))
    beat = 1 + 0.18 * clamp(1 - (remaining % 1) / 0.25) if remaining % 1 > 0.75 else 1
    f = eb.font(eb.FX, int(96 * beat))
    d.text((cx, cy + 4), str(n), font=f, fill=INK, anchor="mm")


# ---------------------------------------------------------------- myth / fact

def myth_panel(scene, local):
    kind = scene.get("kind")
    is_myth = kind == "myth"
    col = RED if is_myth else GREEN
    w, h = W - 120, 700
    c = eb.white_card(w, h, radius=40)
    d = ImageDraw.Draw(c)
    d.rounded_rectangle((0, 0, w - 1, h - 1), 40, outline=col, width=10)
    tf, lines = eb.fit_lines(d, scene.get("big") or scene["text"], eb.FB, 64, w - 140, 6, min_size=40)
    total = len(lines) * (tf.size + 14)
    y = 230 + max(0, (h - 290 - total) // 2)
    for ln in lines:
        d.text((w // 2, y), ln, font=tf, fill=INK if not is_myth else (71, 85, 105), anchor="ma")
        y += tf.size + 14
    if is_myth and local > 0.9:
        # Strike through the claim once it has been read out.
        k = clamp((local - 0.9) / 0.5)
        y0 = 230 + max(0, (h - 290 - total) // 2)
        for i, ln in enumerate(lines):
            lw = d.textlength(ln, font=tf)
            ly = y0 + i * (tf.size + 14) + tf.size * 0.6
            d.line(((w - lw) / 2, ly, (w - lw) / 2 + lw * k, ly), fill=RED, width=7)
    # Stamp slams in from big to normal.
    st = stamp("MYTH" if is_myth else "FACT", col, 96)
    s = 2.2 - 1.2 * eb.ease(local / 0.22)
    if local < 0.22:
        st = st.resize((max(1, int(st.width * s)), max(1, int(st.height * s))), Image.BICUBIC)
        a = st.split()[3].point(lambda v: int(v * clamp(local / 0.15)))
        st.putalpha(a)
    c.alpha_composite(st, (max(0, (w - st.width) // 2), max(0, 110 - st.height // 2)))
    return c


# ---------------------------------------------------------------- hack

def hack_panel(scene, local, dur, n, total_steps, theme):
    kind = scene.get("kind")
    w, h = W - 120, 700
    c = eb.white_card(w, h, radius=40)
    d = ImageDraw.Draw(c)
    cx = w // 2
    if kind == "payoff":
        lf = eb.font(eb.FB, 44)
        d.rounded_rectangle((cx - 150, 50, cx + 150, 120), 35, fill=GREEN)
        d.text((cx, 85), "RESULT", font=lf, fill=(255, 255, 255), anchor="mm")
        tf, lines = eb.fit_lines(d, scene.get("big") or scene["text"], eb.FB, 70, w - 120, 6, min_size=42)
        total = len(lines) * (tf.size + 14)
        y = 160 + max(0, (h - 200 - total) // 2)
        for ln in lines:
            d.text((cx, y), ln, font=tf, fill=INK, anchor="ma")
            y += tf.size + 14
        return c
    # Step number in a circle that spins in.
    spin = eb.ease(local / 0.35)
    r = int(74 * (0.4 + 0.6 * spin))
    circle_badge(d, cx, 120, r, theme["accent"])
    num = eb.font(eb.FX, int(80 * (0.4 + 0.6 * spin)))
    d.text((cx, 124), str(n), font=num, fill=theme["accent_ink"], anchor="mm")
    d.text((cx, 220), f"STEP {n} OF {total_steps}", font=eb.font(eb.FB, 36), fill=(100, 116, 139), anchor="ma")
    tf, lines = eb.fit_lines(d, scene.get("big") or scene["text"], eb.FB, 64, w - 120, 5, min_size=40)
    total = len(lines) * (tf.size + 14)
    y = 300 + max(0, (h - 380 - total) // 2)
    for ln in lines:
        d.text((cx, y), ln, font=tf, fill=INK, anchor="ma")
        y += tf.size + 14
    # Progress dots, the current one filled; a tick appears when the step is done.
    for i in range(total_steps):
        x = cx + (i - (total_steps - 1) / 2) * 56
        on = i < n
        d.ellipse((x - 14, h - 70, x + 14, h - 42), fill=theme["accent"] if on else (226, 232, 240))
    tick_mark(d, w - 100, 110, 70, (local - max(0.5, dur - 0.2)) / 0.4, GREEN, 14)
    return c


# ---------------------------------------------------------------- sound effects

SFX_SRC = {
    "whoosh": "anoisesrc=d=0.45:c=pink:a=0.6,highpass=f=500,lowpass=f=4500,afade=t=in:d=0.18,afade=t=out:st=0.18:d=0.27",
    "pop": "aevalsrc='0.7*sin(2*PI*(500+900*t)*t)*exp(-28*t)':d=0.14",
    "ding": "aevalsrc='0.45*sin(2*PI*1318*t)*exp(-4*t)+0.3*sin(2*PI*1976*t)*exp(-5*t)':d=0.9",
    "tick": "aevalsrc='0.8*sin(2*PI*1900*t)*exp(-90*t)':d=0.08",
    "buzz": "aevalsrc='0.32*(sin(2*PI*140*t)+0.6*sin(2*PI*285*t))*exp(-3.2*t)':d=0.5",
    "thud": "aevalsrc='0.95*sin(2*PI*(110-60*t)*t)*exp(-11*t)':d=0.35",
    "chime": "aevalsrc='0.35*sin(2*PI*1046*t)*exp(-5*t)+0.3*sin(2*PI*1318*t)*exp(-5*(t-0.09))*gte(t,0.09)+0.3*sin(2*PI*1568*t)*exp(-5*(t-0.18))*gte(t,0.18)':d=1.0",
}


def sfx_track(ffmpeg, work, events, total):
    """Mixes [(seconds, name)] into one stereo WAV; returns its path, or None."""
    events = [(t, n) for t, n in events if n in SFX_SRC and 0 <= t < total]
    if not events:
        return None
    files = {}
    for name in {n for _, n in events}:
        f = os.path.join(work, f"sfx_{name}.wav")
        subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-f", "lavfi", "-i", SFX_SRC[name], "-ac", "2", "-ar", "48000", f], check=True)
        files[name] = f
    inputs, filt = [], []
    for i, (t, n) in enumerate(events):
        inputs += ["-i", files[n]]
        ms = int(t * 1000)
        filt.append(f"[{i}:a]adelay={ms}|{ms}[e{i}]")
    filt.append("".join(f"[e{i}]" for i in range(len(events))) + f"amix=inputs={len(events)}:duration=longest:normalize=0,apad,atrim=0:{total:.2f}[s]")
    out = os.path.join(work, "sfx.wav")
    subprocess.run([ffmpeg, "-y", "-loglevel", "error", *inputs, "-filter_complex", ";".join(filt), "-map", "[s]", "-ac", "2", "-ar", "48000", out], check=True)
    return out


def sfx_events(style, scenes, starts, clips, gap):
    """Which sound plays when, from the scene timings."""
    ev = []
    for i, sc in enumerate(scenes):
        k = sc.get("kind")
        t0 = starts[i]
        dur = clips[i][1]
        if i > 0:
            ev.append((max(0.0, t0 - 0.15), "whoosh"))
        if style == "quiz" and k == "quiz":
            for j in range(min(3, len(sc.get("options", [])))):
                ev.append((t0 + (0.25 + 0.18 * j) * max(1.0, dur), "pop"))
            for s in range(int(sc.get("hold", 0))):
                ev.append((t0 + dur + gap + s, "tick"))
        elif k == "answer":
            ev.append((t0 + 0.1, "ding"))
        elif k == "myth":
            ev.append((t0 + 0.2, "thud"))
            ev.append((t0 + 0.9, "buzz"))
        elif k == "fact":
            ev.append((t0 + 0.2, "thud"))
            ev.append((t0 + 0.35, "ding"))
        elif k == "step":
            ev.append((t0 + 0.05, "pop"))
            ev.append((t0 + max(0.5, dur - 0.2) + 0.15, "tick"))
        elif k == "payoff":
            ev.append((t0 + 0.1, "chime"))
        elif k == "headline":
            ev.append((t0 + 0.05, "ding"))
        elif k == "action":
            ev.append((t0 + 0.45, "pop"))
        elif k == "cta":
            ev.append((t0 + 0.1, "chime"))
    return ev
