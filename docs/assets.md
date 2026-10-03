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
| `process_sheet.py` | 4×4 walk sheet → `sheetCell×frames` square (content/config.json `sprites`): cells from alpha projections snapped to an even grid, one uniform scale (tallest frame → target height), feet on the cell bottom (`bottomMargin`), centred on the torso, left/right rows verified (face-side heuristic + mirror similarity) and fixed by mirroring/swapping, every row rebuilt into a walk cycle (`walk_cycle.py`), rows with an H3 walk clip take their cycle from the clip (`walk_video.py`), shared palette |
| `walk_cycle.py` | AI rows repeat one pose, so each row is rebuilt from its medoid frame by moving leg pixels only (`pipeline.json` `sheet.walkCycle`): frames 0/2 legs together (0 = idle), 1/3 contact with the body `bob` px lower. Front/back: leg band (`legFrac`) split between the feet, a lifted foot planted first (`maxPlant`), one half raised `lift` px per contact frame. Side: the drawn stride is the contact frame, the passing frame shears both legs together (`tuck`). `python3 tools/walk_cycle.py in.png out.png` previews it on a sheet processed with `enabled: false` |
| `walk_video.py` | MiniMax H3 walk clips (`pipeline.json` `walkVideo`, prompts `templates.json` `walkVideo`). `prep <id>`: each row's idle frame, padded and scaled onto magenta, becomes the seed `<rawDir>/<id>/<dir>.png` (kept once it exists; `--force` overwrites) plus `<dir>.json` with both filled prompts. Upload and submit through the xiaochui-video MCP (i2v, 1:1, 0.4 MP, 3 s; `prompt` with firstFrame = lastFrame = seed), save the result as `<rawDir>/<id>/<dir>.mp4`. A rejected clip is resubmitted with `promptFirstFrame` and only the first frame: with an identical last frame H3 often morphs the background colour mid-clip. `process_sheet` keys every video frame back onto the sheet grid, drops unusable frames (stray pixels beyond the seed silhouette, head top far off), finds the stride phase from the head bob (contact = head lowest, passing = highest) and takes one passing-contact-passing-contact run with alternating feet as frames 0-3. Body, arms and legs come from the clip; the head is the seed's own (raised by the bob); colours are the seed's. A sheet uses its clips only when all 4 rows have a usable one, otherwise the whole sheet keeps the `walk_cycle.py` cycle. `frames <id>` / `cycle <id> out.png` write QA strips |
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
| character sheet | `public/assets/characters/<id>.png` | 256×256 RGBA, rows down/left/right/up × 4 frames (legs together/idle, contact, legs together, other contact), 64×64 cells, feet on row 61, binary alpha |
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

Roster source: `assets_src/prompts/creatures.json` (190 records: `id`, `nameEn`, `nameZh`, `family`, `stage`, `types`,
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

```bash
python3 tools/run_pipeline.py --kind creature --only gpt-35,deepseek-v3,kling-1,suno-v3   # a batch of ids
python3 tools/run_pipeline.py --kind creature                                              # every missing creature
python3 tools/run_pipeline.py --kind creature --only kling-1 --force kling-1              # re-roll one render
python3 tools/contact_sheet.py public/assets/creatures --scale 2 --cols 6 --out /tmp/creatures.png   # QA
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

- Walk cycles come from H3 clips: the head is frozen to the drawn idle head (only the bob moves it), so side rows
  whose clip turns the torso to pure profile on the passing frame show a 3/4 head on a profile body. Rows without a
  usable clip use the synthesized cycle (legs only, no arm swing; skirts show only the feet stepping).
- `trainer_streamer` and a few light-haired characters have no dark outline (as drawn).
- Facing check is weak for characters whose whole body is skin-toned (`trainer_swimmer`); verified by eye.
- Cliff tiles (`cliff_rock`, `cliff_dirt`, `cliff_snow`) repeat visibly at 32 px; `dark_grass`/`tall_reeds` use a
  tighter crop (`texture.cropByKey`) so blades stay readable.
- `nurse` wears a red-cross cap (from the character description); swap the description if that symbol is a concern.
- Renders in `assets_src/raw/` are gitignored: reprocessing needs them; regenerating produces different art.
