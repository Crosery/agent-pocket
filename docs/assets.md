# 2D asset pipeline (characters, portraits, terrain, UI)

AI renders → true pixel art in `public/assets/**`. Two generator backends (`pipeline.json` `generator.backend`,
override per run with `--backend`): `aigw` (default; any OpenAI-compatible image gateway, `/v1/images/generations` / `/v1/images/edits`, model
`gpt-image-2.5-flare`; base URL and key from env `AIGW_BASE_URL` / `AIGW_API_KEY` or the untracked
`assets_src/pipeline.local.json`) and
`crosery` (local generator `crosery-ct call crosery_image_generate`; the only one that takes reference images).
Every asset id comes from `content/*.json`; every prompt word and processing number lives in JSON. The Python
tools contain only algorithms.

> Reference images (`assets_src/refs/**`) and machine-local settings (`assets_src/pipeline.local.json`: gateway base URL, secrets file) are private and not in the repository. Put your own references there and set `AIGW_BASE_URL` / `AIGW_API_KEY` (or the local JSON) before running the generator.

## One command

```bash
python3 tools/run_pipeline.py                 # build jobs → generate missing renders → process → manifest
python3 tools/run_pipeline.py --kind portrait # one kind
python3 tools/run_pipeline.py --force character/rival,logo   # regenerate specific renders
python3 tools/run_pipeline.py --no-generate   # reprocess existing renders only
```

Adding a character / terrain / biome / type to content and running the command above is all that is needed.

## Data files

| file | role |
|---|---|
| `assets_src/prompts/templates.json` | per-kind prompt template, generator variant/quality, processor, output path, and the content **source** the ids come from (`file`, `id` field, `where`, `exclude`, `fields`, `groupCount`), optional `lookups` (per-record text picked by a key template); shared style snippets `{style.*}` |
| `assets_src/prompts/details.json` | per-id descriptive detail for terrain / cliff / tuft / types / biomes, and the per-character cute note (`characters`, used by the `character` and `portrait` kinds). Missing ids fall back to `detailFallback` (`{nameZh} ({idWords})`), so new content still works |
| `assets_src/prompts/jobs.json` | **generated** by `tools/build_jobs.py`: `[{id, kind, prompt, variant, quality, process, out, meta}]` |
| `assets_src/pipeline.json` | every processing number: chroma key, grid search range, sheet margins/fill/palette, portrait/texture/tuft/icon/backdrop/logo sizes and palettes, per-kind/per-key texture crop overrides, generator backend (aigw base URL/model/sizes, key env name) and concurrency/retries/timeout, manifest kinds |
| `assets_src/raw/<kind>/<id>.png` (+ `.json` sidecar with the prompt) | generator output, gitignored. `_failures.jsonl`, `_process_report.json` are logs |

Kinds and sources today: `character` (content/characters.json), `portrait` (characters with `portrait: true`),
`terrain` (content/terrain.json keys except `void`), `cliff` (unique `cliff` of content/biomes.json), `tuft`
(terrain with `tallGrass: true`), `type_icon` (content/types.json `icon`), `battle_bg` (biome `battleBg`),
`title`, `logo`, `creature` (assets_src/prompts/creatures.json, see below).

## Tools

| tool | does |
|---|---|
| `build_jobs.py` | content + templates + details → `jobs.json` |
| `gen_images.py` | batch runner (ThreadPoolExecutor, ≤ 6 concurrent); idempotent (skips existing renders), `--force ids`, `--only`, `--kind`, `--backend aigw|crosery`, retries once, never resubmits after a local timeout; the sidecar `result` records backend and model |
| `pixelize.py` | generic: chroma-key magenta (distance ramp, peel the key/subject blend band, despill) → bbox → estimate source pixel grid + phase (edge spectrum) → medoid sample at cell centres → binary alpha → speck/pinhole/halo cleanup → optional palette |
| `process_sheet.py` | The original 4×4 AI source stays a 4×4 input. Its legacy output remains four columns unless all directional H3 clips pass; then the output is a nine-column complete-body atlas. Alpha projections determine source cells, with one uniform scale, baseline anchoring, facing repair and a shared palette |
| `walk_cycle.py` | AI rows repeat one pose, so each row is rebuilt from its medoid frame by moving leg pixels only (`pipeline.json` `sheet.walkCycle`): frames 0/2 legs together (0 = idle), 1/3 contact with the body `bob` px lower. Front/back: leg band (`legFrac`) split between the feet, a lifted foot planted first (`maxPlant`), one half raised `lift` px per contact frame. Side: the drawn stride is the contact frame, the passing frame shears both legs together (`tuck`). `python3 tools/walk_cycle.py in.png out.png` previews it on a sheet processed with `enabled: false` |
| `walk_video.py` | Directional H3 clips become a separate idle plus eight chronological whole-body poses. No static head/torso grafts and no duplicated passing frames. Whole-frame translation grounds the sole and removes horizontal camera drift; palette mapping retains the reference colors. Selection checks temporal recurrence, leg alternation, body motion, connectivity and the loop seam, without requiring a head bounce. Tiny diagonally connected hands are retained. `rawDirV2` clips take priority over original `rawDir` clips; row reports identify the source and whether it was regenerated |
| `rebuild_walk_atlases.py` | Read-only source processing into `output/motion-qa/full-body`, never directly overwrites shipped PNGs. Exports only sheets with all four usable directions and writes a provenance report. `--only id1,id2` and `--workers 2` support targeted retries |
| `audit_character_motion.py` | Read-only checks for binary alpha, planted baseline, detached clusters, distinct poses, body/arm motion and loop seams. `--require-atlas` rejects legacy four-frame sheets. `--only id1,id2` filters characters and `--animation path.gif` exports chronological four-direction loops. Intentional reference props remain allowed; visual review is still required for missing anatomy and identity drift |
| `process_creature.py` | creature battle sprite, see [Creatures](#creatures) |
| `process_portrait.py` | bust → 128 work canvas (bottom-aligned) → binary alpha + palette → nearest ×2 = 256 |
| `process_texture.py` | best-wrapping crop search; structured textures (grout, planks, bricks) crop a whole number of detected periods; otherwise two-pass half-offset blend; 32×32 palette tile. `--tuft` for magenta tufts → `<key>_tuft.png` (base on the bottom row) |
| `process_ui.py` | `icon` (32×32 emblem, 1px outline in a dark shade of the type colour), `backdrop` (cover-crop, medoid ÷`pixel`, palette, nearest up to 1536×1024; `keepSize` keeps the source size), `logo` |
| `process_all.py` | runs the right processor for every job whose render is newer than its output (`--all` to force); `keyart` = title key art (`cover.fix.backdrop`: source size, pixel 2, no palette) |
| `contact_sheet.py` | QA grids; `--tile 4` repeats textures 4×4 to check seams; `--thumb` for big art |
| `build_cover.py` | title-cover candidates with the AI-girl cast: `jobs` builds the 3×3 cast identity board (approved chibi PNGs), the frozen style ref and per-concept composition drafts (chibis pasted on a plate) → `assets_src/prompts/cover_jobs.json` (prompts in `prompts/cover.json`, numbers in `pipeline.json` `cover`); render with `gen_images.py --jobs assets_src/prompts/cover_jobs.json`; `pixel` = backdrop processing (`cover.backdrop`, palette 0 = no quantise) → `raw/cover/pixel/`; `layered` = keyed character layers over the plate; `fixjobs` / `finish` = targeted repaints of the chosen cover (`cover.fix`: upscaled crop + reference board per patch, prompts in `cover.json` `fix`, plus a top extension to 4:3) → only the changed pixels inside each patch zone are blended back, light grades applied → `raw/cover/cover_final.png` + `pixel/cover_final.png`; the shipped key art is that file copied to `assets_src/raw/title/title.png` and processed by `process_all.py --only title/title` |
| `build_manifest.py` | scans `public/assets/**` → `public/assets/manifest.json` (`--check` = stale test). Safe for any agent to run |

QA loop: `python3 tools/contact_sheet.py public/assets/characters --cols 7 --out /tmp/chars.png`, view, then
`--force kind/id` the bad ones (≤ 2 retries each).

Tests: `node --test tests/assets_pipeline.test.ts` (templates/pipeline shape, jobs in sync with content, manifest in
sync with disk, every present asset matches its size/alpha/baseline spec; missing assets are diagnostics only) and
`python3 -m unittest discover -s tools -p 'test_*.py'` (band split, chroma key, grid estimate, seam blend, facing
fix, walk cycle synthesis, H3 clip cycle pick, end-to-end sheet on `assets_src/walk_sheet_reference.png`).

## Outputs

| kind | path | spec |
|---|---|---|
| character sheet | `public/assets/characters/<id>.png` | 1024×256 RGBA built by `tools/sprite2d.py` from the 2D base sheet (see 2D Character Motion): rows down/left/right/up, idle columns 0–7, walk columns 8–15, used as-is. Legacy 576×256 sources (neutral + 8 walk) are still expanded to 1024×256 on load; 256×256 sources and procedural fallbacks expand to 768×256 (eight idle + four walk). Every cell is 64×64, soles on row 61, binary alpha |
| creature | `public/assets/creatures/<id>.png` | `sprites.creatureSize` (128) square RGBA, true pixel art, feet on row `size-1-creature.bottomMargin`, ≤ `creature.palette` colours, binary alpha |
| portrait | `public/assets/portraits/<id>.png` | 256×256 RGBA bust (128 native, nearest ×2) |
| terrain | `public/assets/textures/terrain/<key>.png` (+ `cliff_*`) | 32×32 opaque, seamless, ≤16 colours |
| tuft | `public/assets/textures/terrain/<key>_tuft.png` | 32×32 RGBA, base on the bottom row |
| type icon | `public/assets/ui/<TypeDef.icon>.png` | 32×32 RGBA |
| battle backdrop | `public/assets/ui/<BiomeDef.battleBg>.png` | 1536×1024 opaque (768×512 native, nearest ×2) |
| title / logo | `public/assets/ui/title.png`, `logo.png` | 1536×1152 (4:3) key art with the nine AI girls, any aspect works (placement: `content/screens.json` `title.art`); logo 1024 wide RGBA, text 智灵口袋 / AGENT POCKET |

## Generator notes

- Proven references: `assets_src/walk_sheet_reference.png`, `assets_src/creature_reference.png`.
- The generator sometimes returns a real RGBA cut-out instead of the magenta background (and semi-transparent
  textures); `chroma_key` keeps source alpha and textures ignore alpha.
- Prompts must not name existing franchises: "Pokemon" in a sheet prompt was rejected by the safety filter and a
  cap emblem came out franchise-like; templates now use `{style.original}`.

## Creatures

Roster source: `assets_src/prompts/creatures.json` (448 records: `id`, `nameEn`, `nameZh`, `family`, `stage`, `types`,
`rarity`, `design`, `lookZh`, `personality`). The `creature` template wraps each `design` in a shared kawaii wrapper:
a single full-body moe chibi mascot personification (gacha/mascot chibi look) whose **cuteness rules override any
proportion, age or mood wording in the design** — ~2 heads tall with an oversized round head, huge sparkly eyes,
rosy blush, small soft rounded limbs, rounded silhouette, cheerful playful pose, signature colours kept with
pastel-leaning accents, nothing realistic/scary/edgy, only the one or two most iconic props — plus 3/4 view facing
front-left, `{style.original}`, `{style.pixel}`, limited palette, ~78 % of the frame height with feet visible, blank
placards / icon-only screens, `{style.noText}`, `{style.keyBg}`. `{stageHint}` comes from the `lookups.stageHint`
table keyed by `{stage}/{familySize}`; `familySize` is a `groupCount` over `family`, so single-form species (`1/1`)
are not drawn as babies while base forms of 2/3-stage lines are the tiniest/most babyish and final forms the fanciest
(still tiny chibis). A new (stage, family size) combination needs a new entry there (the test lists it).
The wrapper also forbids floating icons / bubbles / sparkles / motion lines (they turn into noise at sprite size).

**Reference images.** `kinds.creature.references` (generic `build_jobs.py` feature: `[{path, note, optional}]`,
paths relative to the repo root, `{n}` in a note = the image's 1-based index, the used notes are joined into
`{refNotes}`) attaches `assets_src/refs/creature/_style.png` (the roster's art-style anchor, DeepSeek chibi) to
every job, plus `assets_src/refs/creature/<family>.png` when that file exists (canonical identity of the 9
persona lines: claude, deepseek, gemini, glm, gpt, grok, kimi, minimax, qwen; copied from the user's Q版角色素材
set, flattened onto white). Jobs with `images` go to the AIGW `/v1/images/edits` endpoint. To give another family a
canon look, drop `<family>.png` into that folder and re-run its ids with `--force`.

A third, optional reference is the neighbouring evolution form: a `creatures.json` record may carry `lineRef`
(the id of the earlier form when drawing a later one, or of the later form when drawing a new earlier one); its raw
render `assets_src/raw/creature/<lineRef>.png` is attached with a "same character, other evolution stage" note so
the new form reads as the same character grown up. Draw forms in chain order (the reference must exist first); the
raw renders are gitignored, so `tests/assets_pipeline.test.ts` only demands the path when the file exists or
`jobs.json` already names it.

```bash
python3 tools/run_pipeline.py --kind creature --only gpt-35,deepseek-v3,kling-1,suno-v3   # a batch of ids
python3 tools/run_pipeline.py --kind creature                                              # every missing creature
python3 tools/run_pipeline.py --kind creature --only kling-1 --force kling-1              # re-roll one render
python3 tools/contact_sheet.py public/assets/creatures --scale 2 --cols 6 --out /tmp/creatures.png   # QA
python3 tools/roster_sheets.py --out docs/previews/creatures                              # numbered 8x6 sheets of every species
python3 tools/roster_sheets.py --ids a,b,c --out output/18/new-creatures                  # only these ids (dex order)
```

`process_creature.py` (parameters in `pipeline.json` `creature`, canvas = `content/config.json` `sprites.creatureSize`):
chroma key → robust subject bbox (stray specks outside it dropped) → pixel grid + phase estimate and medoid
sampling at native resolution (`pixelize.py`) → when the native sprite does not fit the canvas minus margins, is
smaller than `minFill` of it (per id: `minFillById`, for coarse-grid renders that come out too small in frame,
e.g. `claude-code`), or the grid confidence is below `minConfidence`, it is instead medoid-sampled at the
cell size that fits it × `fill` (feet anchored) → binary alpha, specks (`minSpeck`, `speckRatio` 0 keeps floating
notes/bubbles), pinholes, key halo → crop → feet on `bottomMargin`, horizontally centred on the torso (`torsoBand`,
clamped to `sideMargin`) → outline cleanup (silhouette pixels with luma > `outline.maxLuma` become
`outline.darken` × their colour, closing a 1px dark outline) → palette ≤ `palette`. The per-job report
(`assets_src/raw/_process_report.json`) records `mode` (`native`/`fitted`), grid, confidence, sprite size, colours,
`outlineDarkened` and `keyLikePixels` (opaque pixels within `keyLikeDist` of the key colour; > 0 hints at magenta
fringe or a magenta design, check by eye). `assets_src/creature_reference.png` is the end-to-end fixture
(`tests/assets_pipeline.test.ts`).

## Cute pass (characters & portraits)

The `character` (walk sheet) and `portrait` kinds draw every NPC as a kawaii / moe chibi while keeping the identity
from `content/characters.json` `desc`:

- `{style.kawaii}` (used only by these two kinds): cuteness rules that override any age, build or mood wording in
  `desc` — soft rounded face, chubby cheeks, huge sparkly eyes with 2-3 highlights, light blush, gentle or playful
  smile, fluffy glossy hair, modest outfit, nothing scary/edgy/sexualised; older characters keep grey hair, beard or
  glasses but stay soft and round. `{style.cutePixel}` replaces the HD-2D `{style.pixel}` wording for them.
- `{detail}` = `details.json` `characters.<id>`: one line of mood / small accessory per character (villains are
  cute-mischievous, the professor kindly and cuddly, burly characters drawn as cuddly chibis). A new character
  without an entry falls back to `detailFallback`.
- Sheets add super-deformed ~2-head proportions (oversized round head, stubby limbs, bouncy walk); portraits add a
  large head in frame, gradient irises, one small cute accessory and soft pastel lighting.

Old renders/outputs from before this pass are kept in `assets_src/backup_cute_pass/` (`raw/<kind>/`,
`characters/`, `portraits/`) for rollback; restoring = copy the raw render back and run
`python3 tools/process_all.py --kind <kind> --only <id> --all`.

## Known imperfect assets

- H3 may still redraw facial details, raise a knee excessively or drift a prop. Whole-body extraction avoids the
  former static-upper-body mismatch, but automatic connectivity and motion checks do not establish perfect anatomy.
  Reject visibly defective candidates rather than hiding defects with static body grafts or interpolated frames.
- `trainer_streamer` and a few light-haired characters have no dark outline (as drawn).
- Facing check is weak for characters whose whole body is skin-toned (`trainer_swimmer`); verified by eye.
- Cliff tiles (`cliff_rock`, `cliff_dirt`, `cliff_snow`) repeat visibly at 32 px; `dark_grass`/`tall_reeds` use a
  tighter crop (`texture.cropByKey`) so blades stay readable.
- `nurse` wears a red-cross cap (from the character description); swap the description if that symbol is a concern.
- Renders in `assets_src/raw/` are gitignored: reprocessing needs them; regenerating produces different art.

## H3 Video-To-Sprite Recipe

Primary references:
[MiniMax first/last-frame prompt guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md),
[MiniMax full-reference guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md),
[ComfyUI H3 native workflows](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-native).

1. Use each existing directional idle as its identity anchor. Pad by 8 native pixels and nearest-scale by 8,
   preserving the existing HD-2D pixel design instead of inventing a replacement character.
2. Use I2VA with `promptFirstFrame`: explicit character features, a fixed orthographic camera, fixed facing,
   flat magenta background, gentle opposing arm/leg motion, connected wrists and low foot clearance.
   Keep carried props in their existing grip. Do not force identical first and last images.
3. The connected 4090 service used for these candidates accepts 0.4 MP, square 640×640, three seconds
   (73 frames at 24 fps), eight sampling steps, no upscale and no RIFE. These are this service's preview settings,
   not a claim about universal official API limits or final quality.
4. Decode original frames with FFmpeg, chroma-key and medoid-sample onto the native 64-pixel grid.
   Extract complete poses from one ordered recurring interval, not independent head, sleeve or leg patches.
5. Export and inspect candidates before replacing assets:

```bash
python3 tools/rebuild_walk_atlases.py --workers 2
python3 tools/audit_character_motion.py output/motion-qa/full-body --require-atlas \
  --report output/motion-qa/full-body-audit.json \
  --playable-cycles output/motion-qa/full-body-playable-cycles.png
```

6. Verify walking, reversing, stopping, idle and all four directions in the real game. The runtime identifies
   atlas width from the loaded image, so asynchronous loads, procedural fallbacks, battle trainers, UI previews
   and online avatars remain compatible with legacy sheets. Standing never enters the eight-frame walk loop;
   step cadence follows actual ground distance rather than the number of atlas columns.

   Different image dimensions require GPU reallocation: the asset loader releases the old WebGL2 storage before
   assigning the loaded image, while retaining the `Texture` object referenced by live materials. Updating only
   `needsUpdate` cannot resize immutable storage from a 256-pixel placeholder to a 576-pixel atlas.

## Character Motion Verification

The current shipped set contains 33 nine-column sheets, 132 directions and 1,188 cells. Seven directional clips
were newly generated with H3; 125 directions were re-extracted from existing H3 clips. All directions were rebuilt
as complete-body poses, not newly generated wholesale. The original artwork, palette, 64-pixel cells and HD-2D
rendering remain the style anchors.

Local QA artifacts are under the gitignored `output/motion-qa/` directory:

| artifact | evidence |
|---|---|
| `final-full-body/report.json` | Clip provenance, selected chronological frame indices and per-direction acceptance |
| `shipped-full-body-audit.json` | 33 sheets / 132 directions / 1,188 frames, zero rejected shipped sheets |
| `atlas-review-1.png` through `atlas-review-6.png` | Full-roster static frame review; this is not real-game playback evidence |
| `newgame-canvas-runtime-qa.json` | Six playable characters, all 24 directions: eight chronological walk columns, baseline 61 and stable column-zero idle |
| `newgame-mobile-qa.json` | Chromium 390x844 with touch emulation enabled before load: direction/standing taps, empty-name validation, 16-character counter, cancel-focus restoration and no horizontal overflow |
| `main-game-runtime-qa.json` | Normal title/Continue into `origin-home`: four directions twice, eight walk columns each, column-zero stops, blocked-wall idle and no WebGL error |
| `main-game-four-directions.webm` / `.mp4` | Recording of the actual main-game canvas, not an atlas GIF or sandbox. The MP4 is nearest-scaled 2x for inspection |
| `playable-motion.gif`, `leaders-motion.gif`, `trainers-motion.gif`, `npcs-motion.gif` | Asset-only loop previews |
| `npm-test-serial.log` | The repository's 432 Node tests pass with `--test-concurrency=1`; typecheck, production build and 16 Python tests also pass |
| `npm-test-after-texture-fix.log`, `world-test-isolated.log` | Default parallel run: 431 pass, one existing world-generation CPU budget failure. Isolated world run: 24/24 pass. Performance thresholds were not relaxed |

The main-game check uses the isolated integer slot `?dev=1&slot=2026100492`; character-selection checks use the
unsaved QA slot `2026100493`. Keep `dev=1` and use a numeric slot: an invalid string or a missing development flag
can fall back to slot zero. Browser target screencasting keeps native animation callbacks active during recording;
no game-clock override, teleport, debug inventory or temporary material override is used in the final checks.
The earlier throttled preview report and blocked-path recording are retained as diagnostics, not passing evidence.

## Directional Idle Animation

`src/client/render/character-idle.ts` expands the existing standing anchors once when an image loads. It uses one
continuous, inverse-sampled body field for shoulder/chest breathing, connected forearm follow-through and a small
neck follow. The lower-leg/sole band and separate reference props are fixed. Pixels come from the original palette,
with nearest sampling and binary alpha; there are no cut-and-paste arms, new character designs, per-frame raster
work, extra downloaded assets or whole-card bobbing. All 33 characters and all four directions use this path.

The built-in image generator produced `output/idle-qa/generated-idle-reference.png` as a motion reference only.
It also redrew the face/proportions, so that output is not used as game art. Its exact prompt is recorded in
`output/idle-qa/reference-prompt.txt`. The shipped PNG anchors and all eight existing H3 walk poses remain intact.
These new idle poses are deterministic pixel articulation, not newly generated H3 clips.

`content/config.json` owns `sprites.sheetIdleFrames`, `idleFps` and `idleSettleMs`. The shared animation controller
keeps idle time independent from displacement-driven walking. A stop/turn begins on neutral before breathing;
repeating `setMoving(false)` cannot reset the idle clock. A blocked moving actor breathes rather than freezing on
a walking frame. Actor spawn phases can be staggered, but subsequent stops reset to the neutral sequence.

World player/NPC/remote billboards, the character-selection live preview/cards and battle trainers use the same
prepared atlas and idle controller. Static portrait/avatar crops intentionally still use the neutral first cell.
Legacy layouts remain readable during asynchronous loads. The existing texture-storage reallocation is preserved
when the prepared canvas replaces the initial 256-pixel-wide texture.

Verification:

- `tests/assets_pipeline.test.ts` checks all 132 directions: unchanged source pixels, idempotent expansion,
  at least four distinct idle poses in each eight-frame timeline, planted soles, binary alpha, no additional
  disconnected body parts, changing shoulder/body/arm pixels and exact preservation of all walk pixels.
- `tests/character-animation.test.ts` checks idle cadence, stopping, turning, blocked input, teleports, world actor
  kinds, same-layout character swaps, asynchronous dimensions and battle trainer frames without whole-card bob/squash.
- `scripts/qa-character-idle.mjs` runs real keyboard moves and samples the native game loop in a confirmed-empty,
  numeric development slot. It checks the eight idle columns, correct row, constant world position, unit scale,
  zero card lift and runtime errors. Preview checks wait for selected-character state and independently loaded
  texture references, then wait for a complete pose cycle within a bounded window. They also record native RAF
  sample counts, visibility and frame gaps. Resume with `first`/`count` without repeating passed characters.
- The world run passed all 33 characters / 132 directions (`world-runtime-report.json`). Character-selection
  previews passed all six playable characters / 24 directions at both 1317x999 and 390x844, without foreign
  direction/walk frames, sole drift or horizontal overflow (`preview-runtime-desktop.json`,
  `preview-runtime-mobile.json`). The narrow run observed all eight distinct poses for every playable direction.
- `transitions-runtime.json` records native keyboard walking on columns 8-15, a key-release stop on columns 0-7,
  and the complete idle loop while the right key remains held against a wall. Stopped and blocked actors keep
  one world position, unit scale and zero card lift, with no runtime errors.
- `npc-runtime.json` records the resident `mom` NPC's four idle directions through the normal `faceNpc` script
  operation and game loop. `battle-runtime.json` records the normal `rival-lab-o1` encounter: both the player's
  rear-facing trainer and the rival's front-facing trainer show all eight idle columns at the command prompt,
  with fixed positions, unit scale, zero card lift and no runtime errors. The battle observation reads the actual
  render view without advancing animation time or manually calling sprite updates.
- Runtime reports, screenshots and the actual game-canvas recording are stored in `output/idle-qa/`, not committed
  source assets. The browser uses an isolated QA slot; never clear shared storage or overwrite slot zero.

These checks do not certify perfect anatomy. H3 can still introduce small face, hair or prop drift. Physical-phone
software keyboards, live remote multiplayer sessions, online-avatar UI and the full browser/GPU matrix have not
been visually verified in this pass. Battle observation covers one encounter, not every character/battle pairing.
The tutorial hint was observed to auto-hide; its exact seven-second expiry was covered by onboarding tests, not a
strict wall-clock browser measurement.

## 2D Character Motion

The 33 character sheets keep the original 2D pixel drawings. Their motion is built in-house by moving the drawn
pixels, not by an image or video model and not by a 3D render.

```bash
python3 tools/sprite2d.py build <id...|all>    # assets_src/sprite2d/base/<id>.png -> public/assets/characters/<id>.png
python3 tools/sprite2d.py review <id...|all>   # 4x sheet + idle/walk GIFs in output/sprite2d/
```

- **Base art.** `assets_src/sprite2d/base/<id>.png` is the original 4-frame 2D walk sheet (256×256), frozen. Edit
  or replace a drawing there.
- **Rig.** Each frame splits into bands: head, body, arms and left/right legs. The neck is the narrowest row in
  `bands.neckBand`, the legs are the bottom `bands.legFrac`, and the arms are the body pixels outside the legs'
  columns below `arms.topFrac`. A band that moves down covers the band below it. A band that moves up leaves a seam
  row, filled by stretching the row under it. Hands move with their arm, so they never detach.
- **Idle (8 frames, all 4 directions).** From the stand pose, with both feet planted first. The body sinks 1 px
  over `idle.body` (a slight knee bend), and the head follows one frame later.
- **Walk (8 frames).** Front/back rows are built from the planted stand pose: one foot lifts `walk.front.lift` px
  per step, the body dips, and the arms counter-swing 1 px (`arms.swing`). Side rows use the drawn strides
  (`walk.sidePoses`). Every pose is shown twice, the first time with the head still at the previous pose's height,
  so the head trails the bob.
- `process_all.py` skips `sheet` jobs that have a base sheet, so `run_pipeline.py --all` cannot overwrite them.
  Portraits are unchanged.

## Field HUD Reference Frames

The field HUD combines the compact layout and subdued ink-green surfaces of design reference 3 with the
stepped gold corners of design reference 4 from the supplied local `/audit/index.html` page. The two existing
transparent frame exports are imported unchanged as `public/assets/ui/hud-frame.png` (detail frame) and
`public/assets/ui/hud-ribbon.png` (location ribbon). Their reference copies are in
`output/ui-reference-fusion/reference-assets/`; these are reference assets, not newly generated images.

`src/client/ui/styles.css` owns the shared frame and colour tokens. Nine-slice borders do not stretch the
corners or bake text into images. Quest and objective disclosures share one mission frame; desktop activity
details use a bottom-centred reader, while compact/touch-landscape layouts keep a bounded inline reader.
The calendar, house and objective icons remain data-driven pixel glyphs in `content/ui.json`.

Name anchors use the first opaque texel in each currently displayed frame, subtract the sole pivot and
apply the exact billboard vertex pose before projection. Bounds are cached per image/layout so names,
NPC bubbles and creature bubbles follow the actual art without reading canvas pixels every frame.
`tests/name-anchor.test.ts` covers character kinds, directions, cache invalidation and camera/model pose;
`scripts/qa-name-anchor.mjs` compares rendered name labels against an independent opaque-row projection.

Verification artifacts are under `output/ui-reference-fusion/`. The source audit runs from a separate temporary
checkout on port 8793; this implementation and its runtime checks use the primary workspace on port 5175 with
the isolated numeric development slot `2026100506`. Both frame PNGs are byte-identical to the audit exports and
are included in `public/assets/manifest.json` and the production build.

- `fusion-report.json` confirms the actual HUD's frame URLs, shared mission container, existing pixel font,
  bottom-centred desktop reader, reading-window precedence and automatic guide expiry (7,220 ms observed,
  including the configured fade). It also covers native Enter/Space activation and Escape/focus restoration for
  chat. Chat controls stop keyboard propagation before the game's input handler without changing game bindings.
- `final-desktop.png`, `final-events.png`, `final-mobile-scrolled.png` and `final-landscape-scrolled.png` are
  screenshots of the actual game, not regenerated design mockups.
- `all-characters-name-report.json` covers all 33 characters and 132 directions. The rendered head/name gap
  stays between 5.50 and 6.50 CSS pixels against the configured 6-pixel offset.
- `output/hud-events-design/responsive-report.json` covers 20 closed/open states across 10 desktop, portrait
  and touch-landscape viewports. `fixture-report.json` also checks empty lists, 1/3/12 events, long names,
  scroll/focus preservation on refresh, visibility and disposal. No overlap, viewport overflow or intercepted
  reading control was reported.

Typecheck, production build and manifest checks pass. The full serial Node run in `tests.log` has 463/464 passing
tests; its remaining failure is the existing 4,000 ms world-generation CPU budget (4,085 ms observed).
`world-isolated.log` records the passing isolated world suite. No performance threshold was relaxed.
Physical phones, software keyboards and other browser engines are not visually verified by these emulated
Chromium checks.

## Teleport anchors (props)

The two anchor props are not part of this sprite pipeline: like every prop they are procedural `parts` styles in
`content/render.json` (`props.styles.warp_anchor`, `warp_anchor_grand`: stone base, rune bands, crystal) lit at night
by the prop light in `content/props.json`, with the activation glow, beam and sparkles drawn by the fx system
(`anchors.beacons`). The map pins are 7×9 / 11×12 pixel glyphs (`mAnchor`, `mAnchorGrand` in `content/ui.json`,
greyed through `worldMap.anchorPalettes.off` in `content/explore.json` while inactive).
