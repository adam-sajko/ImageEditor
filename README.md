# ImageEditor

Simple image editor that runs in the browser. Images never leave your machine.

Live: https://adam-sajko.github.io/ImageEditor/

To run it locally, open `index.html` or serve the folder:

```bash
python3 -m http.server 8000
```

Copying to the clipboard only works over `localhost` or HTTPS.

## What it does

- Open a file, drag it into the window or paste it with Ctrl+V
- Crop (free or 1:1, 4:3, 16:9), resize, rotate, flip
- Brightness, contrast, saturation
- Grayscale, sepia, invert, blur, sharpen
- Undo, redo, revert to the original
- Export to PNG, JPEG or WebP, or copy to the clipboard
- Works on phones (pinch to zoom, drag to pan)

## Shortcuts

| Key | Action |
| --- | --- |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo |
| Ctrl+E | Export |
| C / R | Crop / resize |
| Enter / Esc | Apply / cancel |
| F / 1 | Fit / 100% |
| + / - | Zoom |
| Space + drag | Pan |

## Limits

- Very large images (over 16384 px per side or 100 MP, 16 MP on iOS) are scaled
  down when opened.
- Animated images are edited as a single frame.
- EXIF and color profiles are dropped on export.

Resizing uses [pica](https://github.com/nodeca/pica).
