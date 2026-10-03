# Agent Pocket · 智灵口袋 — code-rendered promo

54.9 s, 1920×1080, 60 fps, H.264 + AAC. Every frame is a pure function of song time `t` (three.js r186 + Vite + TypeScript), exported by headless Chrome → raw RGBA → ffmpeg. No AI video generator was used. Generated media: the music cue (MiniMax Music3, instrumental) and, on the end slate, the game's own AI-generated title key art (`public/assets/ui/title.png`, an existing game asset). Sound effects are the game's own chiptune SFX recipes, re-synthesised offline.

Concept, plates and style rules: `docs/TREATMENT.md`. Sources and what was taken from each: `docs/RESEARCH.md`. Licences: `THIRD_PARTY.md`.

## Preview

```sh
cd promo
~/.bun/bin/bun install          # once (deps live in promo/package.json only)
~/.bun/bin/bun run sync         # copy game assets into public/game + audio/game, write data/game.json (re-run when content/ changes)
~/.bun/bin/bun run dev          # http://localhost:5241/  (port 5241 only)
```

URL params: `?t=31.5` start time, `&only=world,title` load only those scenes (faster).
Keys: `space` play/pause · `←/→` ±1 s (`shift` ±5 s) · `,` / `.` ±1 frame · `[` / `]` previous/next plate · `l` loop current plate · `h` hide UI.

Preview shows each plate as it will export except motion blur (export only); it plays `audio/trailer.wav` (music only). Edit any `data/*.json` and reload.

## Build order (picture ↔ sound share one timeline)

```sh
uv run --with librosa --with soundfile --with scipy python analysis/edit.py                      # music -> audio/trailer.wav
uv run --with librosa --with soundfile --with scipy --with matplotlib python analysis/analyze.py --plot   # -> data/audio.json (beat grid)
bun scripts/render.ts sfx                                                                        # scenes' sound events + cuts + duration -> data/sfx_events.json
uv run --with numpy --with soundfile --with scipy python analysis/mix.py                         # music + SFX -> audio/final.wav (-14 LUFS, -2 dBTP)
bun run render                                                                                   # video, muxed with audio/final.wav
uv run --with numpy --with pillow python scripts/check_cuts.py                                   # double-exposure check + out/cuts_sheet.png
uv run --with pillow python scripts/contact_sheet.py                                             # out/contact_sheet.png (30 frames)
uv run --with numpy --with pillow python scripts/plate_luma.py out/agent-pocket-promo.mp4         # per-plate median/min/max/corner luma + max/min ratio
uv run --with pillow python scripts/frames.py out/agent-pocket-promo.mp4 --t 21.5,21.52 --cols 4 --out /tmp/f.png   # frame-exact tiles for review
```

Re-run `sfx` + `mix` whenever cues, plates or `data/sfx.json` change (the mix is pinned to the film's length).

## Render

All commands from `promo/`; the script starts its own no-HMR Vite server on 5241 if none is running.
If you add a new scene file while a server is up, kill it first (`lsof -ti :5241 | xargs kill`): `import.meta.glob` is cached.

```sh
bun run render                                                    # = video --samples auto --shutter 0.5 --out out/agent-pocket-promo.mp4
bun scripts/render.ts video --samples 1 --preset veryfast --crf 20 --out out/wip/draft.mp4   # fast draft
bun scripts/render.ts stills --t 5.5,24.6,51.4 --out out/stills   # PNG stills at song times (engine, 1 sample)
bun scripts/render.ts sheet --from 32 --to 40 --n 8 --cols 4 --out /tmp/s.png
bun scripts/render.ts perf --from 34 --to 35 --samples auto      # ms per frame
```

Video: libx264 `-preset slow -crf 16 -tune grain -x264-params aq-mode=3`, yuv420p, BT.709 tags, AAC 320 k / 48 kHz, `+faststart`.
`--samples auto` = adaptive motion blur (4 → 12 → 36 → 108 → 324 sub-frames per frame until the image stops changing by more than `--tol` levels). **A hard cut closes the shutter**: the engine collects every cut (plate boundaries + each scene's `cutTimes()`: faces, multiply steps, rarity tiers, the hook's second line) and clamps a frame's sub-frames to the side of the cut that holds its reference point, so no frame is a double exposure. Full render (rev 3): 1080 s for 3295 frames (sub-frames 12:1714, 36:430, 108:591, 324:560; the golden-hour diorama plates dominate).
Type, logo tiles, bubbles and pops are **frame-stepped** (`Frame.ft` / `Frame.flb`: song time / plate beat snapped to the frame and constant across the shutter), so motion blur never smears them.

## Music and sound

- `audio/raw/music3/trailer_v{1,2,3}.wav` — three Music3 takes (captions in `audio/caption_v*.txt`); v2 chosen by spectrogram for its arc. `analysis/edit.py` → `audio/trailer.wav`; `analysis/analyze.py` → `data/audio.json` (BPM 125.7, beat grid, downbeats, sections, band energies, onsets).
- The film ends on bar 28 (54.92 s): the final chord has decayed to −54 dB there; picture and sound fade together over 0.9 s (rev 2; 1.2 s before), then 0.2 s of pure black/silence (grain and dither fade with the picture).
- Sound design: each scene declares its sound events (`Scene.sfx()`, times from the same cues as the picture); `data/sfx.json` maps them to the game's own recipes (`audio/game/sfx.json` ← `content/audio/sfx.json`) transposed to the cue's D major, plus two recipes of our own (`boom`, `boomSmall`). `analysis/mix.py` synthesises them (numpy implementation of the recipe format), adds a short hall reverb, mixes under the music, fades and loudness-normalises.

## Data (nothing is hard-coded in scenes)

| file | what |
|---|---|
| `data/timeline.json` | plates in **bars** of the analysed music (`from`/`to`), per-plate cues in **beats from the plate's first downbeat**, optional per-plate `shutter` factor |
| `data/copy.json` | every visible string (zh + en), player names and lines |
| `data/cast.json` | which species/characters appear where (reveal, faces + per-face beats, multiply grids, catch, rarity ladder + beats, world, together, battle + its attacks); promo-only `displayNames` |
| `data/style.json` | palette (incl. `halo`), fonts, pixel-font spacing, type scales (incl. `narratorScale` ×6 / `narratorEnPx` 36, `overPicture` outline), layout; per-plate look (`multiply`, `catch` incl. tuft tints/jitter/contact shadow, `castArc` (the reveal's heroine arc), `rarity`, `battle` incl. rim/ground, `pocket`, `title` incl. `keyArt` crop/push/reveal/darkening and `shine`); `halo` per plate; `grade` per picture plate; `platePost` (bloom/vignette per plate); post; motion |
| `data/world.json` | diorama: noise, levels, biomes → textures/props, golden-hour `light` (key, hemisphere, shadow intensity/radius, sky stops, sky-sun direction, disc, glow, pool, sprite/tuft tint), `look` (pixelDiv, outline, god rays, clouds + cloud shadows, fireflies, blob shadows, rim, emissive, water, side tint), prop density, clear circles, characters (Scale2x); world plate camera/radius/fog keys, frontier rise, extras + their beats, encounter grass; `catch` backdrop camera/fog/focus; together plate camera, walk, bubbles, whoosh lead |
| `data/sfx.json` | sound events → game SFX recipes (dB, pitch), own recipes, `duck` (music dips under given events), reverb, master loudness + fade |
| `data/music.json` | music edit + analysis parameters, section names, mix output |
| `data/assets.json` | which game files are copied into `public/game/` / `audio/game/` and which fields go into `data/game.json` |
| `data/game.json`, `data/audio.json`, `data/sfx_events.json` | generated (sync / analyze / `render.ts sfx`) — do not edit |

## File map

```
src/engine/   engine (adaptive sampling, cut-closed shutter, plate dispatch, sfx export), post, gl, sprites (instanced
              pixel-art batches, half-float glow falloff), text (pixel face with hair-space/dot rules, glyph body, mono), assets, audio, data, util
src/scenes/   hook, reveal, faces, multiply, catch, rarity, world, together, battle, pocket, title
              _kit.ts (backdrop + navy halo, safeGlowI, creature drawing, labels, sparkles with keep-out rects, cursor, typing sfx),
              _diorama.ts (HD-2D hybrid path: low-res environment + depth outline, full-res billboards on layer 1 with blob shadows and sun-side rim,
              golden-hour sky with pixel clouds, god rays, cloud shadows, water, fireflies, standable-tile search, tilt-shift, grade)
src/engine/grade.ts   per-plate grade + separable blur (picture plates, applied before type)
src/timeline.ts, src/main.ts   plate table from data, preview/export entry
scripts/      render.ts (export, stills, sheet, perf, sfx), sync-assets.ts, check_cuts.py, contact_sheet.py, plate_luma.py, frames.py, cuts_sheet.py (rev 0), tile.sh
analysis/     edit.py (music), analyze.py (beat grid), mix.py (sound design + master), small exploration scripts
out/          agent-pocket-promo.mp4 (rev 3), agent-pocket-promo.v3.mp4 (rev 2), .v2 (rev 1), .v1 (rev 0), contact_sheet.png, cuts_sheet.png,
              stills/ (rev 3, frame-exact PNGs from the MP4), *.v3 / *.v2 / *.v1 = earlier revisions
```

## Decisions

- **Engine lineage:** ported from mexicat/pdoom-video (MIT) — same f(t) contract, adaptive motion blur and post chain; chromatic aberration off and grain low because pixel-art edges must stay one pixel wide. Added: cut-closed shutter.
- **Pixel integrity:** holds at whole scales (or exactly ½× for the 64- and 190-grids, which is a clean 2×2 box), snapped to the art-pixel grid; anything that scales or moves goes through the `pixelUV` filter. Chinese copy is Fusion Pixel rasterised at 12 px and scaled ×2–×8 with smoothing off.
- **Gold is light, not paint:** additive cores (r ≤ 60 px), thin beams and sparks over a navy field; the falloff around them is the navy-blue halo (`palette.halo` #1d2a4a), and tier/face glows are capped (`safeGlowI`) so field pixels keep B > R. Flashes are neutral, radial on the subject (corners stay dark) with a 1-frame core.
- **Only real game material:** creature sprites, character sheets, terrain textures, GLB props, battle backdrop, logo, title key art, and the game's SFX recipes — copied at build time (`bun run sync`), never imported from in-flux game modules.
- **Golden hour is the world's colour, gold light is the signal:** the picture plates (catch, world, together, title) share the key art's sunset palette; the navy plates keep gold for light only.
- **Only supported claims:** 190 species (counted from `content/`), rarity N→MYTHIC by capability, a generated world, online play/battle/trade, browser. No URL, price or date on screen. The N tier is shown by 「Codex 初代」 (a first-generation model drawn as a hatchling), not by a competitor's current product.

## Revision 1 (critic score 6.3) — what changed

| note | done |
|---|---|
| 1-frame double exposure at almost every cut | Shutter closed at every cut (plate boundaries + `cutTimes()`). `scripts/check_cuts.py` flags 6 suspect frames in rev 0 and **0** in rev 1. |
| MYTHIC muddy olive, UR red-on-red | Field stays navy; gold only as an additive core (r 300) + 7 thin beams; post flash bone, half-life 15 ms (≈2 frames), UR has none; sprite flash ≤ 0.6; 22 sparks with a 40-px keep-out around the sprite and 24 px around the label; tier labels have an ink outline and wait 0.2–0.3 s after the landing. |
| world: floating/lake creatures, dirt pit, near shot, visible disc under "没有尽头" | Extras snap to the nearest dry, level, prop-free tile and drop in (squash) once the frontier has passed them; spawn plateau widened (radius 7, blend 9) so the foreground step is gone; first key is a mid shot; from beat 7 the frontier races to r 118 while the camera tilts to the horizon, fog keys hide the edge, and the line sits on the horizon. |
| ending: dead air, no accent, not black, sparks on type | Film ends on bar 28 (54.92 s, −2.7 s); `catch` jingle + sub boom on the logo; 1.2 s fade + 0.2 s pure black (grain/dither fade too); sparks keep 24 px clear of logo, tagline and CTA. |
| 190 wall long, soft, repeated | Multiply is 2 bars: 4 (2×) → 16 (1×) → 64 (½×) → 190 (½×, 19×10) with a big gold count ticking under the grid; ~1 bar of the full grid; the line types under the number. The 2 freed bars went to the rarity ladder (3-beat holds, 4-beat charge). |
| slow start, dead hold, dead `reveal` copy | Cursor visible at frame 0, typing at 0.5 s; bar 3 of the reveal: the card gives way to the cursor typing 「现在，见见它们」. |
| together cluttered | Path in the lower third, walkers enter from the frame edges, meetGap 2.2, front-facing frames at rest, bubbles 14 px over the heads with tails and the name as header; tags/arrows removed; copy at the top. |
| typography | Hair space (2 art px) between CJK and Latin; '·' as a 2×2 art-px square with 2 art px either side; cursor = CJK body height on the baseline; CTA one goldHi, CJK body centre on the caps centre; half-width '!' in the bubble. |
| no sound effects; −0.8 dBTP | Game SFX on every action (see TREATMENT "Sound design"); master −14.0 LUFS, −1.8 dBTP measured on the AAC. |
| trade unreadable / too many ideas | Trade cut; bar 23 is Kai's counter-attack (same idea, both players act). Ladder captions removed; rarity line 4 beats only. |
| ½-beat name cards flicker | Cards are fully opaque on the cut frame. |
| hit burst invisible; HP text 14 px | 16 squares (3 art px) in the attacker's type colour, 0.45 s; panels: player name and creature name in the pixel face (×2/×3), rarity chip ×2, no 14-px mono. |
| logo breaks the gold thread | The burst's light cools from gold to the logo's own blue over 0.3 s; sparks take the logo's highlight colour. |

Pushed back / not done:

- *Give the saved time to world or the ending*: plates are pinned to the music's sections (world = the breakdown, bars 16–20; the ending is bounded by the final chord's decay), so the two bars went to the rarity ladder instead.
- *Draw the trainers at the partners' pixel density*: that makes partners twice the trainers' height (or trainers half size). Kept the game's proportions; mitigated with mid shots and front frames at rest.
- *CTA URL / search term*: needs your decision (`data/copy.json` has no url field yet).

## Revision 2 (critic score 7.2, "revise") — what changed

Measured on the exported MP4 with `scripts/plate_luma.py` (per-plate median luma, 8-bit) and pixel samples of the stills.

| note | done |
|---|---|
| **major** — the grade breaks at world/together/battle (luma 56/51/126 vs 15–32) | Per-plate grade in data, not code: `style.json grade.<plate>` (exposure, saturation, contrast, tint) runs inside the scene before its type, plus `platePost` (bloom, vignette to ink). World and together are dusk: low sun from frame-left with long shadows, cool hemisphere fill, a 3-stop sky (navy zenith → cool mid → thin warm horizon band) instead of the void. Battle: the backdrop is its own plane, blurred 9 px, exposure ×0.055, saturation 0.7, cool tint; both sprites get a 1-art-px warm rim (`battle.rim`). Medians v2 → v3: world 62.5 → 45.4, together 56.9 → 43.0, battle 127.2 → 43.2. Cut 43.46 now 43 → 43, cut 47.28 43 → 26. Max/min of plate medians: **1.75×** without the hook (see pushback). |
| **major** — world reads as a voxel demo, protagonists lost | Opens low and close on the pair (hero ≈ 223 px, partner ≈ 210 px tall at 32.03 s) on a clearing lit by a warm spot pool, encounter grass in the foreground (12 near tufts + an 18-tuft ring, defocused by the tilt-shift), then one crane up and back. Every material fogs toward the sky colour of its own view ray, so the world dissolves into the warm horizon band and 「一个没有尽头的世界」 sits on light. The gold frontier is a band on the newly risen tiles, with a minimum width so it still reads from altitude. Props ×0.6 (`propDensity`), clear circles so no pine blocks the opener, water roughness 0.22 for highlights. The lit clearing keeps the pair findable in the wide (pool light on them to the last frame). |
| rarity is 21 % of the film; catching never appears | `timeline.json` re-split, MYTHIC still on bar 15: faces 4–8, multiply 8–10, **new `catch` 10–12**, rarity 12–16. Catch: a wild Gemini 3.8 Flash hops in two rows of tall grass; a prompt-ball arcs in on beat 1 and hits on 2; the creature flashes gold and streams pixel by pixel into the ball; the ball drops and bounces, the camera pushes in (integer 6 px per art px); two shakes on 4 and 5, the click with three stars on 6; 「抓到了 Gemini 3.8 Flash！」 (the game's own catch message). All game SFX (`exclaim`, `step` as the grass rustle, `ball_throw`, `bump`, `stat_down`, `ball_shake`, `catch`). The caught one is the partner in world, together and battle, so the pocket's two shakes + catch sting now pay off a setup. Rarity: N → UR every 2 beats, 2-beat charge in which the five lit pips fly on curves into the point while the MYTHIC pip fills and blinks with the riser. |
| together: pixel-density mismatch, class-photo row, Pokémon-like trainers | 3/4 overhead dusk shot (the game's camera), diagonal path, the two players walk toward each other from the first measured onset and meet facing each other, partners trailing; the bubbles (name as header) carry the beat. Trainer sheets are upscaled with Scale2x/EPX (tolerance 24; no blur, no new colours) so their edge steps match the 128-px creatures. Trainers swapped to `hero_engineer` (Lin) and `hero_hacker` (Kai). **Flag for the game owner:** `hero_girl` / `hero_boy` (white hat + pink ribbon, red/white cap + blue jacket) resemble Serena/Leaf and Ash — an IP-resemblance risk in the game itself; the promo no longer shows them. |
| gold turns into brown/khaki at reveal, MYTHIC hold, pocket point | Gold core ≤ 60 px; the falloff is a navy-blue halo (`palette.halo` #1d2a4a, radius/intensity per plate in `style.json halo`); reveal/faces glow in the sprite's own tone via `safeGlowI` (capped so the field never turns warm). Field samples now: reveal (39,56,68) (was 41,36,37), MYTHIC hold (33,41,67) (was 25,26,33), pocket point at 80/200 px (30,41,70)/(27,38,65) (was 116,104,82 / 61,56,53). B > R at every field sample. |
| MYTHIC and logo flashes are full-frame grey lifts | Radial additive flash on the subject (`flash {I, r 520/560, halfLifeSec 0.012}`) + a 1-frame bone core (r 150/160). Corner luma at the landing: MYTHIC 6.5 → 10.2 (was 7 → 102), logo 6.2 → 10.5 (was 7 → 65). Sprite flash half-life 20 ms. |
| logo tiles soft/mosaic, ~80 debris | Tiles are frame-stepped: a column sweep from the centre over ½ beat, each tile binary per frame with a 3-frame landing flash, so every tile is crisp when it lands. Debris capped at 20, gone after 0.4 s. |
| lockup readable only 1.66 s; 12 sparkles; no CTA destination | Tagline at beat 0.5, CTA at beat 1: the full lockup is complete at 51.8 s and holds to the fade at 53.82 s (≈ 2.0 s). 3 sparkles, none within 120 px of the type. `copy.cta.url` added (empty = hidden) — waiting for your decision. |
| 190 / 位 orphaned, English repeats the number | One lockup: 「190」 ×12 with 「位 AI」 ×4 on the digits' ink baseline (typed on its own cue), the pair centred; line 2 「化身像素伙伴」 ×4; English "Each one a pixel companion." |
| full-width brackets; '·' hugs Latin | Promo-only `cast.displayNames` (ChatGPT, Gemini 4 Argon, GPT-6 Astra); '·' gaps are measured from the neighbours' ink bearings, not advances. |
| secondary type too small for phones | English 30 px, dex/maker mono 26 px, rarity captions ×3 (36 px), pips 16 px, battle names ×3, bubbles ×3. |
| rarity headline crowds the sprite | Headline at y 56; ≈ 55 px clear of the R ahoge and the N curl. |
| N/R labels in black boxes | Outline only on UR and MYTHIC, navy at 60 %. |
| hook cursor never gold | Cursor at intensity 1.0 (no bloom blow-out): on = (240,222,163) ≈ goldHi; off = true blink to the field (21,26,43). |
| battle entry ghost; 「效果拔群！」 smeared | Entry is a stepped hop (30 → 10 px → squash, frame-indexed). All type pops are frame-stepped (`Frame.flb`), so the shutter never smears them. |
| battle backdrop scaled ×1.25 | Treated as a defocused, darkened plane (blur 9 px + grade): the non-integer scaling is invisible. |
| cuts at 9.10 / 39.65 may feel early | Cuts stay on the downbeat; the accents moved to the measured onsets instead: the first face lands on the bass hit at 9.35 s (cue `firstLand` 0.52 beat), the walkers' first step at 39.88 s (`walkStart` 0.5). |

Pushed back:

- *Plate-median ratio < 2× counting the hook*: the hook is an empty navy field with one line of type by design (median 12.4). Holding every picture plate within 2× of it would cap world/together/battle at luma ≈ 25, which is near-black for a lit diorama. Without the hook the ratio is 1.75×, and no cut jumps more than 43 → 26.
- *Rim-lighting both battle sprites with a separate light*: done as a 1-art-px offset rim in the warm flash colour (cheap, pixel-exact) rather than a soft glow, which would blur sprite edges.
- *Catch line in English*: left without an English sub-line — the creature's name is Latin already and the action is shown.

## Revision 3 (critic score 7.4) — what changed

Priorities taken from the critique: (1) world/together unmistakably HD-2D and beautiful, (2) the AI美少女 appeal up front, (3) pacing, type and artefacts.

| note | done |
|---|---|
| **major** — world/together read as a voxel demo, not HD-2D | `_diorama.ts` rewritten as the hybrid HD-2D path: the environment renders at 640×360 (`look.pixelDiv` 3) with a depth texture, is upscaled nearest-neighbour (texelFetch) into the 2× buffer with its depth and a 1-px depth outline (fades with fog); billboards render on camera layer 1 at full resolution, depth-tested against it (depth bias toward the camera on depth only). **Golden hour** from the key art: warm key from front-left (I 16), lavender hemisphere fill, soft violet shadows (`shadow.intensity` 0.6, PCF radius 3), a separate sky-sun on the horizon behind the subjects (sun disc, glow, god rays — GPU Gems 3 ch. 13 radial blur of sky pixels), navy-violet → violet → orange sky with procedural pixel cumulus lit on the sun side, drifting cloud shadows, water with a Fresnel sky reflection and pixel glints, emissive crystals, 70 fireflies (one low-res px, HDR), blob contact shadows under every billboard, a 1-art-px inside-edge rim on the sun side of every billboard. The crane now ends on a 3/4 wide with the pair ≈ 120–130 px tall (was a top-down map). Latent bug fixed: billboards sampled the non-square atlas with a square texel size (soft vertically). |
| **major** — the title is a logo on navy | The end slate is the game's own key art (`public/assets/ui/title.png`, nine heroines under the sunset castle): it blooms out of the gold point (the art's sun is mapped onto the point, reveal radius + over-exposure), pushes in 1 → 1.03, with darkened ellipses behind the logo and under the tagline/CTA and a vignette to ink; the burst light is warm; tagline ×6, CTA outlined. Provenance in `THIRD_PARTY.md`. |
| **major** — energy sags at world → together | The world plate is the fix above. Together: camera keys re-aimed and the walk shortened (`walkFrom` 2.6 → 2.1, `partnerLag` 1.3 → 1.0) so both pairs sit in the centre third on the cut (pair centres ≈ 640 / 1260 px); the copy is on screen on the cut frame; a low whoosh (`cutWhoosh`) peaks on the 39.65 downbeat. Footsteps +10 dB, chat +6 dB. |
| **major** — the hook drags and the girls appear late | Hook ends on bar 1 (3.37 s, was 5.28); the reveal runs bars 1→4; bar 3 is a **meet-the-cast arc**: DeepSeek-V4 centred at 3×, the other eight heroines at 2× popping outward on the 8ths, each in her own glow, 「现在，见见它们」 typed under them (`style.json castArc`). Faces are now 16 *other* species (豆包 … 宇树 GD01), so nothing repeats. Narrator lines ×6 with English 36 px (`type.narratorScale`, `narratorEnPx`). |
| **major** — the catch is a flat sticker scene | Staged in the diorama clearing at golden hour (fixed camera + `setViewOffset` matching the 2-D push, cached per zoom); the game's tall and dark tufts alternate with 0–2 art-px jitter (dark ones warmed from grey-violet to dusky olive, `catch.darkTint`); contact shadow under the wild one; the ball lands on the ground line on its own shadow; catch SFX +6 dB; the music ducks 3 dB under each shake (`sfx.json duck`, `analysis/mix.py`). |
| cast continuity | DeepSeek-V4 is the catch's wild one, the world partner, Lin's partner in together and the left fighter in battle; Kai's partner is Gemini 3.8 Flash; 海螺 H3 (MiniMax) joins the cast. |
| SFX too quiet | face +8, faceFast +6, pop +8, ripple +6 dB (`data/sfx.json`). |
| logo shine was a soft flash | An additive 3-art-px band clipped to the logo's alpha, quantised to the art grid, frame-stepped (`title.shine`). |
| battle rim on both edges; floating | Rim on the light-facing edge only, inside the sprite (`SpriteBatch.setRim`, 50 %); warm ground pools and dark contact shadows that shrink in the air; plate shutter 0.25. |
| motion-blur smear on ripple, gather, MYTHIC debris | Ripple and MYTHIC debris are frame-stepped (`Frame.flb`); per-plate shutter factor (`timeline.json` plate `shutter`: multiply 0.5, battle/pocket 0.25); debris goldHi, 10 pieces. |
| rarity line overstays; tier labels static | `copyOut` 3.0 beats; the tier label bobs one art px for 0.1 s on landing. |

Measured on the exported MP4: `check_cuts.py` 36 cuts, **0** suspect frames; master **−14.0 LUFS, −1.9 dBTP** (ebur128 on the AAC), 54.92 s, 3295 frames. Plate medians (`plate_luma.py`, 8-bit): hook 13.4, reveal 34.1, faces 31.5, multiply 35.6, catch 148.0, rarity 28.1, world 138.5, together 133.9, battle 42.7, pocket 25.2, title 121.3. Together cut (39.65 s): pair centres ≈ 640 / 1260 px. World end (39.63 s): DeepSeek-V4 ≈ 120 px, Lin ≈ 130 px tall.

Pushed back / not done:

- *Open the faces on DeepSeek-V4*: the reveal arc already puts DeepSeek-V4 centre-stage at 3× two seconds earlier, and she returns in catch, world, together, battle and the key art. Opening the faces on her again would repeat a shot within 2 s, which the same critique flagged; the faces show sixteen other species instead.
- *Plate-median ratio*: catch, world, together and title are now golden-hour pictures and deliberately brighter than the navy plates (plate medians above); the cut into and out of them lands on downbeats with an accent.
- *Painted chibi portraits* (the author's private reference set, not in this repo): not used — painted, not pixel art, and the key art already shows the nine heroines.
- *Camera snapping (Holland)*: not added; the crane moves 1–3 low-res px per frame and the motion blur integrates the creep.

## Known issues

- Music and SFX levels were set from measurements (per-event level vs local music level; master −14.0 LUFS, −1.9 dBTP on the AAC), not by ear in this environment; listen once before release.
- 「一个没有尽头的世界」: the critic checked the claim against the game's docs (infinite frontier, `docs/world.md`); if the frontier is not live at release, use 「一个不断生长的世界」 / *A world that keeps growing.* (`data/copy.json world`).
- Scale2x matches the trainers' edge steps to the creatures', but their interior detail is still the 64-px drawing: in the world opener the difference is visible on close look. Proper fix is in the game: 128-px trainer sheets.
- The god rays, fireflies and cloud shadows are tuned for 1080p; on a phone the fireflies (one low-res px = 3 screen px) are barely visible — by design, they are texture, not subject.
- 海螺 H3 is shown as the game names it; MiniMax H3 video generation was not used for anything.
- CTA destination (URL or 搜索「智灵口袋」) is not shown until `copy.cta.url` is filled.
- The master is ~245 MB (CRF 16, `-tune grain`; the golden-hour plates carry far more detail than the navy ones): a delivery master, not an upload-size file.
- The picture plates are now much brighter than the navy plates (plate medians: catch 148, world 139, together 134, title 121 vs 25–36), so the cuts multiply → catch → rarity and together → battle are big luminance jumps. Intentional (two worlds: the navy "chat" field and the golden game world), all on downbeats, one cut per several seconds (not a WCAG flash sequence) — but the rev-1 critic asked for ≤ 2× plate medians; if that constraint returns, lower `style.json grade.<plate>.exposure` for catch/world/together.
- `scripts/render.ts` leaves its private Vite server running if the page fails to load; kill port 5241 before retrying.
