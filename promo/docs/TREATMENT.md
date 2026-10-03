# Agent Pocket · 智灵口袋 — promo treatment & style bible

## The idea in one sentence

**你每天都在和 AI 说话，却从没见过它们 — 你认识的每一个 AI，都装进口袋。**
*You talk to AI every day but have never seen them — every AI you know, now in your pocket.*

The film's single motif is **the cursor**: the gold block that blinks in every chat box. It types the first two lines, unpacks pixel by pixel into the first AI companion, and at the end every creature spirals back into it before it bursts into the game's key art and logo on the final chord — the key art's setting sun sits exactly where the point was. Pixel → companion → the cast → a crowd → a world → friends → back to one pixel → the title. The first and last images grow from the same point of light.

## Tone

- Minimal and confident. A dark navy field, one subject on the centre column, one short line of copy at a time, long enough to read. Nothing moves without a reason; big changes land on downbeats.
- Warm, not cold-tech: the creatures are cute, the light is golden, the music is a JRPG theme. No glowing brains, no code rain, no neon, no lens-flare soup, no stock "AI" imagery.
- Honest: only real assets from the game (creature sprites, character sheets, terrain textures, GLB props, the battle backdrop, the logo, the title key art) and only claims the game supports (190 AI species, rarity N→MYTHIC by capability, a procedurally generated world, online play: PvP, trades, chat, in the browser). No URLs, no prices, no dates.

## Palette (data/style.json)

From the game's own UI (`src/client/ui/styles.css --ap-*`):

| name | hex | role |
|---|---|---|
| ink | `#05070d` | edges of the field, shadows |
| navy | `#0e1424` | the field, the void beyond the world, fog |
| bone | `#f6f2e7` | Chinese copy (never blooms) |
| ash | `#9da3b6` | English copy, metadata |
| gold / goldHi | `#c9a45c` / `#f3dca0` | **the signal**: cursor, dex numbers, the big count, frontier line, sparks, CTA — the only colour allowed to glow. **Gold is only ever light** (additive cores, thin beams, sparks): the field never takes it. A dim gold wash over navy reads olive/brown, so falloffs stay tight and the field stays navy. |
| halo | `#1d2a4a` | the falloff around every glow: gold stays in a core of r ≤ 60 px, the light beyond it is navy-blue, so the field keeps B > R (warm glows are capped by `safeGlowI`) |
| sky | `#8fd3ff` | the second player only |

**Flashes** are neutral (bone), radial on the subject (r ≈ 500–560 px, corners rise ≤ +5 luma) with a 1-frame core, half-life 12 ms; never a full-frame lift.

**Picture plates** (catch, world, together, battle, title) are graded in data (`style.json grade`, `platePost`). The diorama is **golden hour**, the key art's light: a sun on the horizon behind the subjects (a separate sky-sun direction, so the faces stay lit by a warm key from front-left), a navy-violet zenith → violet → orange horizon sky with pixel cumulus lit warm on the sun side, soft violet shadows (shadow intensity 0.6 over a lavender hemisphere fill), cloud shadows drifting over the tiles, fireflies (one low-res pixel each), emissive crystals, god rays from the sun, every material fogging toward the sky behind it. The navy plates stay navy: golden hour is the world's colour, gold light is still the signal everywhere else. The battle backdrop is a defocused, darkened plane; the sprites carry a 1-art-px warm rim on the light side only.

**The rare accent:** the six rarity colours (`content/rarities.json`: N `#c9c9c9`, R `#5fb0ff`, SR `#b07cff`, SSR `#ffb43c`, UR `#ff5c5c`, MYTHIC `#ffe66b`) belong to plate 5 and appear nowhere else (plate 8's small rarity chips excepted). Faces get a faint glow in *their own* sprite tone, so each cut changes colour without adding palette.

## Typography (two faces)

- **Fusion Pixel 12px** (OFL, the game's face): all Chinese copy, names, tier labels, UI. Rasterised at 12 px and scaled ×2/×3/×4/×6 by whole numbers with smoothing off: every glyph pixel is an exact square on the frame's pixel grid.
- **IBM Plex Mono** (OFL): small English under each Chinese line, dex numbers, makers, CTA — the machine voice. Letter-spaced, ash or gold.
- Copy blocks are centred on the frame's centre column (eye trace). Narrator lines (hook, reveal, pocket, tagline) are Chinese ×6 (72 px) over English 36 px; other lines Chinese ×4 (48 px) over English 30 px; secondary lines (dex, maker) ≥ 26 px, captions ×3 (36 px) — sized for a phone. Over a picture (world, together, catch, title) the Chinese carries a 1-art-px ink outline and the English (bone) an ink shadow (`type.overPicture`). Copy types on in the cursor's rhythm (16th or 8th notes); every narrator line (hook, reveal) is typed *by the gold cursor*, which is exactly the CJK glyph body tall and sits on its baseline.
- Spacing in the pixel face (`style.json type.pixelSpacing`): a space touching CJK is a 2-art-pixel hair space; '·' is a 2×2 art-pixel square on the CJK body's centre line, its gaps measured from the neighbours' ink (not their advance). Half-width '!' in speech bubbles. On-screen names drop the game's bracketed glosses (`cast.displayNames`).
- Type never smears: it is drawn at frame-stepped time, so the motion-blur shutter sees one state.
- Where possible the type *is* the picture: the big gold count (4 → 16 → 64 → 190) in plate 4, the tier names in plate 5, the world line on the horizon in plate 6, the line the spiral orbits in plate 9. The CTA sets Chinese (pixel) and English (mono) in one goldHi on one visual centre line (CJK body centre = cap-height centre).

## Pixel-art rules

- Sprites are shown big: 4× (512 px) for single creatures, integer scales on every hold, positions snapped to the art-pixel grid.
- Anything that scales, squashes or moves goes through the pixelUV filter (texel-centre snap + 1-screen-pixel edge blend): crisp, no shimmer, no smear. No chromatic aberration; grain is low (0.03) so single-pixel edges survive.
- 3D (HD-2D, hybrid path): the environment — the game's 32-px terrain textures and GLB props — renders at a low internal resolution (640×360, `look.pixelDiv` 3) with its depth, is upscaled nearest-neighbour with a 1-px depth outline, and the pixel-art billboards (creatures, trainers) render on top at full resolution, depth-tested against it, with blob contact shadows and a sun-side rim; then god rays, box downsample, tilt-shift band, grade. Trainer sheets (64 px) are upscaled with Scale2x/EPX so their edge steps match the 128-px creatures.

## Motion rules

- Hard cuts on downbeats (every plate boundary is a bar line of the analysed music).
- Landings: drop + small squash on contact, settle in ~0.3 beat. Pops: `outBack`. Moves: `outExpo` / `inOutCubic`. Idle: a one-art-pixel bob on the beat.
- Accelerate into sections (faces: 2 → 1 → ½ beat per cut), breathe before the peaks (rarity: two beats of charge before MYTHIC; the cadence gathers everything into one point before the title).

## Music

A dedicated instrumental cue (MiniMax Music3 via `crosery-ct advanced_music_generate`, caption in `audio/caption_v1.txt`, seed 777), chosen from three takes because it has a real trailer arc; edited in `analysis/edit.py` (fade, synthetic reverb tail, −14 LUFS). 125.7 BPM, 4/4, bar = 1.909 s. Sections (from `analysis/analyze.py`, bars of `data/audio.json`):

| bars | time | section | character |
|---|---|---|---|
| −1…3 | 0.00–9.10 | intro | soft pad, plucks, no bass |
| 4…15 | 9.10–32.01 | groove | bass and pulse enter; three 4-bar phrases |
| 16…19 | 32.01–39.65 | breakdown | strings, then near-silence |
| 20…23 | 39.65–47.28 | finale | re-entry without bass, full from bar 22 |
| 24…25 | 47.28–51.10 | cadence | sustained chords |
| 26… | 51.10–57.61 | final chord | the tonic chord rings out |

The film ends on bar 28 (54.92 s): by then the final chord has decayed to −54 dB, so the last 2.7 s of the raw cue (near silence) are not used. The picture fades over 0.9 s and holds pure black for the last 0.2 s; the sound fade is the same curve (`data/sfx.json master`).

## Sound design

The game's own chiptune SFX (its recipe table `content/audio/sfx.json`, copied to `audio/game/`) re-synthesised offline (`analysis/mix.py`) and placed by the scenes themselves (`Scene.sfx()` → `data/sfx_events.json`), so every sound sits on the same cue as the picture. Restraint (Derek Lieu): sounds are part of the score — tuned to the cue's D major, on the beat, mostly 15–25 dB under the music, with one hero sound per moment:

- typing: one soft `select` tick per character (alternating a whole tone), −29 dBFS peak;
- the unpack: `heal` arpeggio; each face: a dex blip; the count: `money` coins rising 0/4/7/12 semitones, `item` on 190;
- the catch: `exclaim` as the wild one appears, a `step` rustle in the grass, `ball_throw`, a `bump` on the hit, `stat_down` as it streams into the ball, `bump` on the landing, `ball_shake` ×2 (the music ducks 3 dB under each, `sfx.json duck`), `catch`;
- rarity: `exclaim` per tier rising through the scale, `evolve` as the 2-beat charge riser, `levelup` + a low thump on MYTHIC;
- reveal: a `menu_open` + `bump` as DeepSeek-V4 lands in the centre of the heroine arc, a `select` pop (an octave up) for each of the eight others on the 8ths;
- world: a soft pop as each heroine drops in behind the frontier; the cut to together: a low `ball_throw` whoosh that peaks on the downbeat; together: footsteps, `chat` per bubble;
- battle: `ball_throw` whoosh on each dash, `hit_super` / `hit` on the impacts;
- the cadence is a catch: whoosh as everything is pulled into the point, `ball_shake` ×2 as the point rocks twice, `catch` + a sub boom on the logo — it repeats the catch plate's sound, so the ending pays off a verb the viewer has seen.



## Plates (data/timeline.json; cues in beats from each plate's first downbeat)

| # | id | bars | time | content |
|---|---|---|---|---|
| 1 | `hook` | −1→1 | 0.00–3.37 | Navy; the gold cursor is there from the first frame. At 0.28 s it types 「你每天都在和 AI 说话」 / *You talk to AI every day.* (×6, English 36 px); at 1.96 s 「却从没见过它们」 / *But you have never seen them.*; at 3.0 s the line fades and the cursor glides to the centre, growing to the reveal's size. |
| 2 | `reveal` | 1→4 | 3.37–9.10 | On the bar-1 downbeat the cursor unpacks: each art pixel of No.001 GPT-3.5 flies out to its place, gold cooling to its true colour; name card *No.001 · GPT-3.5 · OpenAI · 2022*. Bar 3 (7.19 s): **meet the cast** — DeepSeek-V4 lands in the centre at 3×, the eight other heroines (GPT-6 Astra, Gemini 4 Argon, Claude Opus 5.5, 海螺 H3, Kimi K3, 通义千问, GLM-5.3, Grok 4.7) pop in at 2× on the 8ths, outward, into a shallow arc, each in her own glow; the cursor types 「现在，见见它们」 / *Now, meet them.* under the group. |
| 3 | `faces` | 4→8 | 9.10–16.73 | The groove enters. One AI per cut, centred at 4×, landing on the beat (the first on the bass hit at 9.35 s), its card fully there on the cut frame — sixteen *other* species, so nothing repeats the arc: 豆包, Midjourney V7, Sora 2, Suno v6, 腾讯元宝, OpenClaw, Neuro-sama, Nano Banana 2, GitHub Copilot, 即梦 Seedance 2.5, Cursor, 通义万相 3.0, MiMo-V2.6-Pro, Claude Code, Genie 3, 宇树 GD01 — cuts accelerate 2 → 1 → ½ beat. |
| 4 | `multiply` | 8→10 | 16.73–20.55 | One becomes all, and the count is the picture: 4 (2×) → 16 (1×) → 64 (½×) → all 190 (½×, a 19×10 grid) on four beats, a big gold pixel number ticking under the grid on each; then 「位 AI」 types onto the number's baseline (「190 位 AI」), 「化身像素伙伴」 / *Each one a pixel companion.* under it; a frame-stepped ripple runs through the crowd. |
| 5 | `catch` | 10→12 | 20.55–24.37 | The verb, in the world's own clearing at golden hour (the diorama behind, defocused; the sun low on the left). A wild DeepSeek-V4 hops up in two rows of encounter grass (the game's tall and dark tufts alternating, each sunk 0–2 art px); a prompt-ball arcs in and hits; she flashes and streams pixel by pixel into the ball; it drops onto the ground line on its contact shadow, the camera pushes in, two shakes (the music ducks under them), the click and three stars: 「抓到了 DeepSeek-V4！」 (the game's own message). She is the partner for the rest of the film. |
| 6 | `rarity` | 12→16 | 24.37–32.01 | 「稀有度，取决于真实实力」 for the first 3 beats, then N → R → SR → SSR → UR every two beats (Codex 初代 hatchling, Kimi, Gemini 2.5 Pro, DeepSeek-R1, ChatGPT), each in a faint glow of its tier colour, the tier label bobbing one art px as it lands; six colour pips at the bottom. Beats 10–12: the stage empties, the five lit pips fly into one point while the MYTHIC pip fills with the riser (frame-stepped gold debris). Bar 15: **MYTHIC · AGI 奇点** — a radial flash with a 1-frame core, shake, a small gold core and thin beams on a navy halo. |
| 7 | `world` | 16→20 | 32.01–39.65 | The breakdown, at golden hour, HD-2D. It opens low and close on Lin and DeepSeek-V4 in a lit clearing, encounter grass soft in the foreground, fireflies, the sun on the horizon behind them; one continuous crane up and back while the world generates outward, tiles rising under a gold frontier band; the other eight heroines drop in where it has passed. It ends on a 3/4 wide — the pair still ≈ 120–130 px tall in the lower third — with the frontier racing into the sunset haze; 「一个没有尽头的世界」 / *A world without end.* types in the sky at 36.3 s. |
| 8 | `together` | 20→22 | 39.65–43.46 | A whoosh into a 3/4 overhead shot (the game's camera), both pairs in the centre third on the cut and 「和朋友一起冒险、对战、交换」 already on screen. Lin (with DeepSeek-V4) and Kai (with Gemini 3.8 Flash) walk toward each other along a diagonal path from the re-entry's first onset, meet and face each other; two speech bubbles, the player's name as each header: 「来对战？」「好!」. |
| 9 | `battle` | 22→24 | 43.46–47.28 | Bar 22 (full band): DeepSeek-V4 and Gemini 3.8 Flash face off on the game's battle backdrop (defocused, darkened), each on a warm ground pool with a dark contact shadow, a rim on the light-facing edge only. DeepSeek-V4 dashes and lands on beat 2 — radial flash, shake, a burst of pixel squares in its type colour, HP falls, 「效果拔群！」. Bar 23: Gemini 3.8 Flash answers on its beat 2. |
| 10 | `pocket` | 24→26 | 47.28–51.10 | The cadence. All 190 turn in a golden-angle spiral around 「你认识的每一个 AI」 / *Every AI you know —* (×6), spiral inward and vanish into one gold point, which rocks twice. |
| 11 | `title` | 26→28 | 51.10–54.92 | The final chord + the catch sting: the point bursts (warm radial flash, 1-frame core) and the game's key art — the nine heroines under the sunset castle — blooms out of it (the art's sun sits exactly on the point), over-exposed for a moment, then pushes in slowly; the sky behind the logo and the bottom edge are darkened for the type. The logo assembles in 16-px tiles in a column sweep from the centre; at 51.46 s a 3-art-px glint, frame-stepped, crosses it; 「都装进口袋」 / *now in your pocket.* on beat ½, 「网页即玩 · PLAY IN BROWSER」 on beat 1 (the full lockup holds ≈ 2 s). Fade to black over 0.9 s, 0.2 s of black. |

Total 54.9 s, 1920×1080, 60 fps. Every hard cut (plate boundaries and the cuts inside faces, multiply, rarity, hook) closes the motion-blur shutter: sub-frames never straddle a cut.
