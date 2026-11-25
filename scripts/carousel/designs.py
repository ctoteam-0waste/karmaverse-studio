"""Carousel slide designs drawn with Pillow.

Usage: python designs.py spec.json
Spec (written by src/lib/carousel/maker.ts):
  design   "notes" | "post" | "bold"
  W, H     slide size in pixels
  hook     cover headline
  slides   [{title, body}] content slides
  cta      closing-slide button text
  brand, handle, site
  logo, mascot   image files
  out_dir, prefix
Prints {"slides": [files]} as the last line.

Designs:
  notes  a notes-app page: cream paper, ruled lines, highlighter on key words
  post   a social-post card (avatar, name, handle, big text, like/comment/save row)
  bold   full-bleed colour blocks, giant slide numbers, Earth Buddy on the cover
"""
import json, os, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "video"))
from PIL import Image, ImageDraw  # noqa: E402
import earth_buddy as eb  # noqa: E402  (fonts, wrapping, mascot cut-out)

INK, MUTED = (28, 25, 23), (120, 113, 108)
GREEN, DEEP, GOLD = (21, 128, 61), (20, 83, 45), (202, 138, 4)


def crop_logo(path, height):
    kv = Image.open(path).convert("RGB")
    gray = kv.convert("L").point(lambda v: 255 if v < 235 else 0)
    kv = kv.crop(gray.getbbox() or (0, 0, kv.width, kv.height))
    return kv.resize((int(kv.width * height / kv.height), height))


def text_block(d, text, path, size, width, max_lines, x, y, fill, gap=14, anchor="la", min_size=36):
    f, lines = eb.fit_lines(d, text, path, size, width, max_lines, min_size=min_size)
    for ln in lines:
        d.text((x, y), ln, font=f, fill=fill, anchor=anchor)
        y += f.size + gap
    return y


def counter(d, W, i, n, fill):
    d.text((W - 60, 60), f"{i}/{n}", font=eb.font(eb.FB, 36), fill=fill, anchor="ra")


def swipe(d, W, H, fill, ink=(255, 255, 255)):
    f = eb.font(eb.FB, 42)
    t = "Swipe →"
    tw = d.textlength(t, font=f)
    d.rounded_rectangle((W - tw - 130, H - 150, W - 60, H - 66), 42, fill=fill)
    d.text((W - 95 - tw / 2, H - 108), t, font=f, fill=ink, anchor="mm")


def save_line(d, W, H, fill):
    d.text((W // 2, H - 110), "Save this · Send it to a friend", font=eb.font(eb.FB, 38), fill=fill, anchor="mm")


# ---------------------------------------------------------------- notes

PAPER, RULE, AMBER, MARK = (255, 251, 232), (238, 226, 190), (217, 119, 6), (254, 240, 138)


def notes_slide(spec, kind, i, n, s, mascot, logo):
    W, H = spec["W"], spec["H"]
    im = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(im)
    for y in range(330, H - 60, 92):
        d.line((60, y, W - 60, y), fill=RULE, width=2)
    d.line((140, 0, 140, H), fill=(252, 165, 165), width=3)
    d.text((60, 60), "‹ Notes", font=eb.font(eb.FS, 42), fill=AMBER)
    counter(d, W, i, n, AMBER)
    if kind == "cover":
        f, lines = eb.fit_lines(d, spec["hook"], eb.FX, 104, W - 260, 5, min_size=60)
        y = 300
        for ln in lines:
            tw = d.textlength(ln, font=f)
            d.rectangle((170, y + f.size * 0.45, 180 + tw, y + f.size * 1.05), fill=MARK)
            d.text((175, y), ln, font=f, fill=INK)
            y += f.size + 26
        m = mascot.resize((int(mascot.width * 0.32), int(mascot.height * 0.32)))
        im.paste(m, (60, H - m.height - 30), m)
        swipe(d, W, H, AMBER)
    elif kind == "content":
        d.text((175, 200), f"{i - 1:02d}", font=eb.font(eb.FX, 96), fill=AMBER)
        y = text_block(d, s["title"], eb.FB, 74, W - 260, 4, 175, 360, INK, gap=22)
        if s.get("body"):
            text_block(d, s["body"], eb.FS, 50, W - 260, 7, 175, y + 40, (68, 64, 60), gap=40)
        lg = crop_logo(logo, 70)
        im.paste(lg, (W - lg.width - 60, H - lg.height - 60))
    else:
        lg = crop_logo(logo, 150)
        im.paste(lg, ((W - lg.width) // 2, 260))
        y = text_block(d, spec["cta"], eb.FB, 70, W - 260, 3, W // 2, 520, INK, anchor="ma")
        d.text((W // 2, y + 40), spec["site"], font=eb.font(eb.FB, 54), fill=GREEN, anchor="ma")
        m = mascot.resize((int(mascot.width * 0.3), int(mascot.height * 0.3)))
        im.paste(m, ((W - m.width) // 2, H - m.height - 160), m)
        save_line(d, W, H, AMBER)
    return im


# ---------------------------------------------------------------- post

def post_slide(spec, kind, i, n, s, mascot, logo):
    W, H = spec["W"], spec["H"]
    im = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(im)
    top, bot = (236, 253, 243), (187, 247, 208)
    for y in range(H):
        d.line([(0, y), (W, y)], fill=eb.mix(top, bot, y / H))
    cw, ch = W - 120, H - 300
    card = eb.white_card(cw, ch, 44)
    cd = ImageDraw.Draw(card)
    av = eb.chat_avatar(mascot, 120)
    card.paste(av, (50, 50), av)
    cd.text((195, 62), spec["brand"], font=eb.font(eb.FB, 46), fill=INK)
    nw = cd.textlength(spec["brand"], font=eb.font(eb.FB, 46))
    cx, cy = 195 + nw + 30, 88  # green check badge
    cd.ellipse((cx - 20, cy - 20, cx + 20, cy + 20), fill=GREEN)
    cd.line((cx - 10, cy, cx - 2, cy + 8, cx + 11, cy - 8), fill=(255, 255, 255), width=5)
    cd.text((195, 118), spec["handle"], font=eb.font(eb.FR, 36), fill=MUTED)
    cd.text((cw - 50, 70), f"{i}/{n}", font=eb.font(eb.FB, 34), fill=MUTED, anchor="ra")
    area_top, area_bot = 220, ch - 170
    if kind == "cover":
        f, lines = eb.fit_lines(cd, spec["hook"], eb.FX, 108, cw - 120, 6, min_size=56)
        y = area_top + max(0, (area_bot - area_top - len(lines) * (f.size + 20)) // 2)
        text_block(cd, spec["hook"], eb.FX, 108, cw - 120, 6, 60, y, INK, gap=20, min_size=56)
    elif kind == "content":
        tf, tl = eb.fit_lines(cd, s["title"], eb.FB, 92, cw - 120, 4)
        bf, bl = eb.fit_lines(cd, s.get("body", ""), eb.FS, 58, cw - 120, 7) if s.get("body") else (None, [])
        total = len(tl) * (tf.size + 18) + (40 + len(bl) * (bf.size + 18) if bl else 0)
        y = area_top + max(0, (area_bot - area_top - total) // 2)
        y = text_block(cd, s["title"], eb.FB, 92, cw - 120, 4, 60, y, INK, gap=18)
        if s.get("body"):
            text_block(cd, s["body"], eb.FS, 58, cw - 120, 7, 60, y + 40, (68, 64, 60), gap=18)
    else:
        lg = crop_logo(logo, 130)
        card.paste(lg, ((cw - lg.width) // 2, 250))
        y = text_block(cd, spec["cta"], eb.FB, 66, cw - 140, 3, cw // 2, 450, INK, anchor="ma")
        cd.text((cw // 2, y + 30), spec["site"], font=eb.font(eb.FB, 50), fill=GREEN, anchor="ma")
    # Reaction row.
    ry = ch - 110
    cd.line((50, ry - 30, cw - 50, ry - 30), fill=(229, 231, 235), width=2)
    hx = 70
    cd.polygon([(hx + 22, ry + 44), (hx, ry + 18), (hx + 6, ry + 4), (hx + 22, ry + 12), (hx + 38, ry + 4), (hx + 44, ry + 18)], fill=(239, 68, 68))
    cd.rounded_rectangle((hx + 110, ry + 2, hx + 158, ry + 40), 14, outline=MUTED, width=4)
    cd.polygon([(hx + 120, ry + 38), (hx + 116, ry + 52), (hx + 134, ry + 40)], fill=MUTED)
    cd.polygon([(hx + 230, ry + 2), (hx + 278, ry + 22), (hx + 230, ry + 44), (hx + 238, ry + 22)], outline=MUTED, width=4)
    bx = cw - 100
    cd.polygon([(bx, ry), (bx + 36, ry), (bx + 36, ry + 48), (bx + 18, ry + 34), (bx, ry + 48)], outline=MUTED, width=4)
    im.paste(card, (60, 150), card)
    if kind == "cover":
        swipe(d, W, H, GREEN)
    elif kind == "end":
        save_line(d, W, H, DEEP)
    return im


# ---------------------------------------------------------------- bold

BLOCKS = [((20, 83, 45), (250, 204, 21)), ((194, 65, 12), (255, 237, 213)), ((3, 105, 161), (186, 230, 253)), ((88, 28, 135), (233, 213, 255))]


def bold_slide(spec, kind, i, n, s, mascot, logo):
    W, H = spec["W"], spec["H"]
    bg, hi = BLOCKS[(i - 1) % len(BLOCKS)]
    im = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(im)
    d.ellipse((W - 420, -260, W + 260, 420), fill=eb.mix(bg, (255, 255, 255), 0.12))
    d.ellipse((-300, H - 360, 360, H + 300), fill=eb.mix(bg, (0, 0, 0), 0.15))
    counter(d, W, i, n, eb.mix(bg, (255, 255, 255), 0.7))
    if kind == "cover":
        f, lines = eb.fit_lines(d, spec["hook"], eb.FX, 120, W - 140, 5, min_size=64)
        y = 170
        for k, ln in enumerate(lines):
            d.text((70, y), ln, font=f, fill=hi if k == len(lines) - 1 else (255, 255, 255))
            y += f.size + 18
        m = mascot.resize((int(mascot.width * 0.42), int(mascot.height * 0.42)))
        im.paste(m, (40, H - m.height - 10), m)
        swipe(d, W, H, hi, bg)
    elif kind == "content":
        d.text((60, 120), f"{i - 1:02d}", font=eb.font(eb.FX, 260), fill=eb.mix(bg, (255, 255, 255), 0.22))
        y = text_block(d, s["title"], eb.FX, 92, W - 140, 4, 70, 460, (255, 255, 255), gap=18, min_size=54)
        d.rectangle((70, y + 20, 250, y + 34), fill=hi)
        if s.get("body"):
            text_block(d, s["body"], eb.FS, 52, W - 140, 6, 70, y + 80, eb.mix(bg, (255, 255, 255), 0.88), gap=18)
    else:
        plate = Image.new("RGB", (W - 200, 220), (255, 255, 255))
        lg = crop_logo(logo, 160)
        if lg.width > plate.width - 40:
            lg = lg.resize((plate.width - 40, int(lg.height * (plate.width - 40) / lg.width)))
        plate.paste(lg, ((plate.width - lg.width) // 2, (plate.height - lg.height) // 2))
        m = Image.new("L", plate.size, 0)
        ImageDraw.Draw(m).rounded_rectangle((0, 0, plate.width - 1, plate.height - 1), 40, fill=255)
        im.paste(plate, (100, 200), m)
        y = text_block(d, spec["cta"], eb.FX, 80, W - 160, 3, W // 2, 500, (255, 255, 255), anchor="ma")
        d.text((W // 2, y + 30), spec["site"], font=eb.font(eb.FB, 54), fill=hi, anchor="ma")
        save_line(d, W, H, hi)
    return im


DESIGNS = {"notes": notes_slide, "post": post_slide, "bold": bold_slide}


def main(spec):
    draw = DESIGNS[spec["design"]]
    mascot = eb.cutout(spec["mascot"])
    slides = spec["slides"]
    n = len(slides) + 2
    files = []
    for i in range(1, n + 1):
        kind = "cover" if i == 1 else "end" if i == n else "content"
        s = slides[i - 2] if kind == "content" else {}
        im = draw(spec, kind, i, n, s, mascot, spec["logo"])
        out = os.path.join(spec["out_dir"], f"{spec['prefix']}_{i:02d}.jpg")
        im.convert("RGB").save(out, quality=92)
        files.append(out)
    print(json.dumps({"slides": files}), flush=True)


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as f:
        main(json.load(f))
