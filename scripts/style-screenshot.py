"""Styles the raw vhs screenshot for the README.

Adds macOS-style terminal window chrome (title bar, traffic lights, window
title), rounds the corners, strokes a subtle border, and paints a soft drop
shadow onto transparent padding, so the image reads as a real terminal window
on GitHub's light and dark themes. Run after `vhs assets/onyx-listen.tape`:

    python3 scripts/style-screenshot.py

The window title needs JetBrains Mono; the script falls back to fc-match and
skips the title if no font is found.
"""

import subprocess

from PIL import Image, ImageDraw, ImageFilter, ImageFont

PATH = "assets/onyx-listen.png"
TITLE = "onyx research — hardware-system"

body = Image.open(PATH).convert("RGBA")
w, h = body.size

# Scale style constants with render resolution (1x = 1200px wide).
SCALE = max(1, round(w / 1200))
RADIUS = 16 * SCALE
PAD = 44 * SCALE
SHADOW_OFFSET = (0, 14 * SCALE)
SHADOW_BLUR = 22 * SCALE
SHADOW_ALPHA = 110
BORDER = (255, 255, 255, 36)

# Catppuccin Mocha chrome: mantle bar over base body, faint divider.
BAR_H = 30 * SCALE
BAR_COLOR = (24, 24, 37, 255)
BAR_DIVIDER = BORDER
TITLE_COLOR = (127, 132, 156, 255)
# macOS traffic lights: 12px dots, 20px spacing, centered in the bar.
DOT_R = 6 * SCALE
DOT_GAP = 20 * SCALE
DOT_X0 = 20 * SCALE
DOT_COLORS = [(255, 95, 87, 255), (254, 188, 46, 255), (40, 200, 64, 255)]


def find_font(px: int) -> ImageFont.FreeTypeFont | None:
    try:
        path = subprocess.run(
            ["fc-match", "-f", "%{file}", "JetBrains Mono"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        if path and "JetBrainsMono" in path:
            return ImageFont.truetype(path, px)
    except (OSError, subprocess.CalledProcessError):
        pass
    return None


# Window = title bar + terminal body.
window = Image.new("RGBA", (w, BAR_H + h), (0, 0, 0, 0))
bar = ImageDraw.Draw(window)
bar.rectangle([0, 0, w - 1, BAR_H - 1], fill=BAR_COLOR)
window.paste(body, (0, BAR_H))
divider = Image.new("RGBA", window.size, (0, 0, 0, 0))
ImageDraw.Draw(divider).line(
    [0, BAR_H - 1, w - 1, BAR_H - 1], fill=BAR_DIVIDER, width=SCALE
)
window.alpha_composite(divider)

# Anti-aliased traffic lights: draw at 4x and downsample.
SS = 4
dots_w, dots_h = DOT_X0 + 2 * DOT_GAP + 2 * DOT_R, BAR_H
dots = Image.new("RGBA", (dots_w * SS, dots_h * SS), (0, 0, 0, 0))
dots_draw = ImageDraw.Draw(dots)
for i, color in enumerate(DOT_COLORS):
    cx = (DOT_X0 + i * DOT_GAP + DOT_R) * SS
    cy = (BAR_H // 2) * SS
    r = DOT_R * SS
    dots_draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)
dots = dots.resize((dots_w, dots_h), Image.LANCZOS)
window.alpha_composite(dots, (0, 0))

font = find_font(13 * SCALE)
if font:
    title_draw = ImageDraw.Draw(window)
    box = title_draw.textbbox((0, 0), TITLE, font=font)
    title_draw.text(
        ((w - (box[2] - box[0])) // 2, (BAR_H - (box[3] - box[1])) // 2 - box[1]),
        TITLE,
        font=font,
        fill=TITLE_COLOR,
    )

ww, wh = window.size
mask = Image.new("L", (ww, wh), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, ww - 1, wh - 1], radius=RADIUS, fill=255)
window.putalpha(mask)

canvas = Image.new("RGBA", (ww + 2 * PAD, wh + 2 * PAD), (0, 0, 0, 0))

shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle(
    [
        PAD + SHADOW_OFFSET[0],
        PAD + SHADOW_OFFSET[1],
        PAD + SHADOW_OFFSET[0] + ww - 1,
        PAD + SHADOW_OFFSET[1] + wh - 1,
    ],
    radius=RADIUS,
    fill=(0, 0, 0, SHADOW_ALPHA),
)
canvas = Image.alpha_composite(canvas, shadow.filter(ImageFilter.GaussianBlur(SHADOW_BLUR)))

canvas.paste(window, (PAD, PAD), window)

border_overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
ImageDraw.Draw(border_overlay).rounded_rectangle(
    [PAD, PAD, PAD + ww - 1, PAD + wh - 1], radius=RADIUS, outline=BORDER, width=SCALE
)
canvas = Image.alpha_composite(canvas, border_overlay)

canvas.save(PATH)
print(f"styled {PATH} {canvas.size[0]}x{canvas.size[1]}")
