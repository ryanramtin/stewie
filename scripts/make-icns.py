#!/usr/bin/env python3
"""Turn any square PNG into a macOS .icns with the native squircle mask.

usage: make-icns.py <source.png> [--out path/AppIcon.icns] [--pad 0.098]
"""
import argparse
import os
import shutil
import subprocess
import tempfile

from PIL import Image, ImageDraw

MASTER = 1024
RADIUS_RATIO = 0.2237  # macOS squircle corner radius / size


def squircle_mask(n: int, ss: int = 4) -> Image.Image:
    m = Image.new("L", (n * ss, n * ss), 0)
    d = ImageDraw.Draw(m)
    r = int(n * ss * RADIUS_RATIO)
    d.rounded_rectangle([0, 0, n * ss - 1, n * ss - 1], radius=r, fill=255)
    return m.resize((n, n), Image.LANCZOS)


def compose(src: Image.Image, pad_ratio: float) -> Image.Image:
    canvas = Image.new("RGBA", (MASTER, MASTER), (0, 0, 0, 0))
    pad = int(MASTER * pad_ratio)
    inner = MASTER - pad * 2
    img = src.convert("RGBA").resize((inner, inner), Image.LANCZOS)

    mask = squircle_mask(inner)
    alpha = img.getchannel("A")
    if alpha.getextrema()[0] < 250:  # source already has transparency
        mask = Image.composite(alpha, Image.new("L", (inner, inner), 0), mask)
    img.putalpha(mask)
    canvas.paste(img, (pad, pad), img)
    return canvas


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("--out", default=".build/AppIcon.icns")
    ap.add_argument("--pad", type=float, default=0.098)
    args = ap.parse_args()

    src = Image.open(args.source)
    master = compose(src, args.pad)

    with tempfile.TemporaryDirectory() as tmp:
        iconset = os.path.join(tmp, "AppIcon.iconset")
        os.makedirs(iconset)
        for size, name in [
            (16, "icon_16x16.png"),
            (32, "icon_16x16@2x.png"),
            (32, "icon_32x32.png"),
            (64, "icon_32x32@2x.png"),
            (128, "icon_128x128.png"),
            (256, "icon_128x128@2x.png"),
            (256, "icon_256x256.png"),
            (512, "icon_256x256@2x.png"),
            (512, "icon_512x512.png"),
            (1024, "icon_512x512@2x.png"),
        ]:
            master.resize((size, size), Image.LANCZOS).save(os.path.join(iconset, name))

        out = os.path.abspath(args.out)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        subprocess.run(["iconutil", "-c", "icns", iconset, "-o", out], check=True)

    master.save(os.path.splitext(out)[0] + "-preview.png")
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
