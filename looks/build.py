#!/usr/bin/env python3
"""Builds the look layouts (dune) from layouts/standard.json and draws their backgrounds.

Each look is standard with a different paint: run this again after changing standard.json so the
looks keep its structure. Writes layouts/<look>.json and backgrounds/<look>.png next to it.
"""
import json, math, os, re, struct, zlib, copy, random, hashlib, glob

HOME = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))  # the herdr-app package root


def png(path, w, h, pixel_rows):
    raw = b"".join(b"\x00" + row for row in pixel_rows)
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "wb").write(data)


# Dune's background: soft rolling waves. Brightness k(u, v, aspect) in 0..1.
def waves(u, v, a):
    # Broad swells: each wave a soft lit crest that fades below it into the trough,
    # like light catching rolling waves; the crests sway at different speeds.
    k = 0.0
    layers = [(0.10, 0.07, 1.6, 0.4), (0.27, 0.09, 1.2, 2.0), (0.44, 0.08, 1.9, 4.1),
              (0.60, 0.10, 1.1, 1.3), (0.76, 0.08, 1.7, 5.0), (0.92, 0.09, 1.3, 3.2)]
    for base, amp, f, ph in layers:
        yl = base + amp * math.sin(u * a * f * 2 + ph) + amp * 0.35 * math.sin(u * a * f * 4.7 + ph * 1.7)
        d = v - yl
        k += math.exp(-(d / 0.03) ** 2) * 0.55 if d < 0 else math.exp(-d / 0.10) * 0.55
    return 0.26 + 0.42 * math.tanh(1.3 * k)


def field_bg(path, field, w=1280, h=800):
    """Dune's background: a brightness field drawn in its colours (near-black to dark brown)
    with film grain against banding. Smaller than the screen: it is soft, and the layout
    scales it up (cover)."""
    base, warm = (8, 7, 6), (61, 39, 22)
    a = w / h
    rnd = random.Random(7)
    rows = []
    for y in range(h):
        row = bytearray()
        for x in range(w):
            k = max(0.0, min(1.0, field(x / w, y / h, a)))
            g = rnd.uniform(-4, 4)
            row += bytes(max(0, min(255, int(b + (c - b) * k + g))) for b, c in zip(base, warm))
        rows.append(bytes(row))
    png(path, w, h, rows)


def stamp(name):
    """backgrounds/<name>.png renamed to <name>-<hash>.png: Herdr caches an image by path,
    so a redrawn background needs a new name to show. Returns the path the layout uses."""
    src = os.path.join(HOME, f"backgrounds/{name}.png")
    digest = hashlib.md5(open(src, "rb").read()).hexdigest()[:8]
    for old in glob.glob(os.path.join(HOME, f"backgrounds/{name}-*.png")):
        if re.fullmatch(re.escape(name) + r"-[0-9a-f]{8}\.png", os.path.basename(old)):
            os.remove(old)
    os.rename(src, os.path.join(HOME, f"backgrounds/{name}-{digest}.png"))
    return f"backgrounds/{name}-{digest}.png"


def look(name, root, pane):
    lay = copy.deepcopy(json.load(open(os.path.join(HOME, "layouts/standard.json"))))
    lay.pop("cloned_from", None)
    lay.update(root)
    def walk(n):
        c = n.get("content")
        if isinstance(c, dict) and isinstance(c.get("pane"), dict):
            c["pane"].update(pane)
        # The sidebar's blocks each paint chrome themselves: a chrome under them too
        # would double it, and hide the background there.
        if n.get("id") == "sidebar":
            n.pop("background", None)
        for ch in n.get("children", []):
            walk(ch)
    walk(lay)
    json.dump(lay, open(os.path.join(HOME, f"layouts/{name}.json"), "w"), indent=2)


DUNE = {
    "theme": "dune",
    "background": {"image": "backgrounds/dune.png", "fit": "cover"},
    # Terminals draw no background of their own: the pane's (rounded, see-through) tints them.
    "terminal_opacity": 0,
    "colors": {
        # surface is opaque: Herdr draws tooltips in it. Mods tint their own cards instead.
        "canvas": "#00000000", "chrome": "#0c09074d", "background": "#0e0b0866", "surface": "#211913f7",
        "popover": "#1a1511f0", "raised": "#ffffff14", "hover": "#ffffff12", "selected": "#ffffff18",
        "border": "#ffffff24", "input": "#ffffff33",
    },
}
if __name__ == "__main__":
    field_bg(os.path.join(HOME, "backgrounds/dune.png"), waves)
    DUNE["background"]["image"] = stamp("dune")
    look("dune", DUNE, {"background": "background", "radius": 14, "border": {"width": 1, "color": "#ffffff26"}, "focus": {"width": 1, "color": "#ffffff59"}})
    print("built dune")
