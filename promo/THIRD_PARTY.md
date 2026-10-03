# Third-party code, fonts and media

## Code

Parts of the renderer are adapted from **mexicat/pdoom-video** (https://github.com/mexicat/pdoom-video), MIT License:

- `src/engine/engine.ts` — timeline playback, scene compositing, adaptive sub-frame motion blur (ternary offsets, error estimate)
- `src/engine/post.ts` — bloom pyramid, halation, tone shoulder, grain, dither, vignette, fades/flash (HUD removed, pixel-safe shake)
- `src/engine/gl.ts` — FSPass, Compositor, Layer2D, makeRT, scaleContext2D, clearRT
- `src/engine/audio.ts`, `src/engine/util.ts`, `src/engine/scale.ts`, `src/engine/scene.ts`, `src/main.ts`
- `scripts/render.ts` — headless Chrome → raw frames over WebSocket → ffmpeg; stills / sheet / perf / video modes
- `analysis/analyze.py` follows the constant-tempo grid fitting idea of pdoom-video's `analysis/analyze.py` (rewritten)
- `src/engine/glsl.ts` — simplex noise by Ashima Arts / Stefan Gustavson (MIT), hashes by Dave Hoskins (MIT)

The pixel-art filter (`pixelUV`) follows the technique described by csantosbh ("Manual texture filtering for pixelated games in WebGL", 2014) and Cole Cecil ("Scaling Pixel Art Without Destroying It", 2017).

`scale2x()` in `src/engine/assets.ts` is our own implementation of the EPX / Scale2x rules as described at https://www.scale2x.it/algorithm (no code copied).

Libraries: three.js r186 (MIT), Vite (MIT), playwright-core (Apache-2.0), TypeScript (Apache-2.0); analysis with librosa (ISC), numpy/scipy (BSD), soundfile (BSD), matplotlib (PSF-style).

```
MIT License

Copyright (c) 2026 Giacomo Magnanini

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Fonts

- **Fusion Pixel 12px Proportional zh_hans** — Copyright (c) 2022, TakWolf. SIL Open Font License 1.1. Copied from the game (`public/assets/fonts/`); license in `public/fonts/licenses/fusion-pixel-OFL.txt`.
- **IBM Plex Mono** (Regular, Medium) — Copyright © 2017 IBM Corp. with Reserved Font Name "Plex". SIL Open Font License 1.1; license in `public/fonts/licenses/IBMPlexMono-OFL.txt`.

## Media

- All images and 3D models are the game's own assets (Agent Pocket, `public/assets/`), copied by `scripts/sync-assets.ts`.
- The end slate is the game's own title key art (`public/assets/ui/title.png`, 1536×1152, an AI-generated illustration owned by the game; copied to `public/game/ui/title.png` by `bun run sync`, listed in `data/assets.json`). It is cropped, pushed and graded in `src/scenes/title.ts`; the pixels are not altered otherwise.
- The painted chibi portraits (the author's private reference set, not in this repo) were reviewed and **not used** (painted, not pixel art; the key art already shows the nine heroines).
- Sound effects: the game's own chiptune SFX recipes (`content/audio/sfx.json`, copied to `audio/game/sfx.json` by `bun run sync`), re-synthesised offline by `analysis/mix.py` (a numpy implementation of the recipe format; no game code is used). Two extra recipes (`boom`, `boomSmall`) are defined in `data/sfx.json`.
- Music: an original instrumental cue generated for this promo with MiniMax Music3 (via `crosery-ct advanced_music_generate`, prompt in `audio/caption_v1.txt`). No third-party songs are used. pdoom-video's song is not used.
