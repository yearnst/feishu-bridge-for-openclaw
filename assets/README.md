# Assets

## Social preview image

GitHub repository social previews work best with a **1280×640 PNG/JPG**.

This folder includes an editable SVG:
- `assets/social-preview.svg`

Convert it to PNG (pick one):

### Option A: ImageMagick
```bash
convert -background '#0B1020' -flatten assets/social-preview.svg assets/social-preview.png
```

### Option B: librsvg
```bash
rsvg-convert -w 1280 -h 640 assets/social-preview.svg -o assets/social-preview.png
```

Then upload `assets/social-preview.png` in:
- GitHub repo → Settings → Social preview
