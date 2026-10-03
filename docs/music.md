# Music (BGM)

Background music is generated offline by the local MiniMax Music3 model (`crosery-ct call advanced_music_generate`)
and post-processed into seamless loops. The game loads `/assets/audio/bgm/<id>.mp3`; a missing file falls back to
the procedural chiptune player.

## Data

| file | contents |
|---|---|
| `content/audio.json` | **track ids** (`bgm[].id`, `nameZh`) and which track plays where — the single source of the track list |
| `assets_src/music/captions.json` | per-track structured captions (genre, BPM, key, mood, instruments, sectioned arrangement), per-category duration + loop search parameters, shared style text, caption template, generation / loudness / encode settings, paths |
| `assets_src/music/raw/<id>.wav` | raw model output (kept; never shipped) + `<id>.json` (seed, steps, caption hash, full caption) |
| `assets_src/music/build_report.json` | per-track loop points, match scores, loudness before/after, ffprobe results, seam metrics |
| `public/assets/audio/bgm/<id>.mp3` | shipped loops: MP3 128 kbps, 44.1 kHz stereo, −16 LUFS integrated, true peak ≤ −1.5 dBTP |

`tools/gen_music.py` contains logic only; every number and string it uses comes from the two JSON files above.

## Adding or changing a track (JSON only)

1. Add `{"id": "...", "nameZh": "..."}` to `content/audio.json` `bgm`.
2. Add a `tracks.<id>` entry to `assets_src/music/captions.json` (`category`, optional `durationSeconds` / `seed`,
   `description`, `genre`, `bpm`, `key`, `scale`, `meter`, `emotion`, `imagery`, `production`, `lead`, `primary`,
   `secondary`, `groove`, `textures`, `sections[] {tag, text}`).
3. `python3 tools/gen_music.py all <id>` (add `--force` to regenerate an existing WAV).

`node --test tests/music.test.ts` fails when a bgm id has no caption, a duration is outside its category range, or a
built MP3 was not verified by the pipeline.

## Commands

```bash
python3 tools/gen_music.py validate            # captions cover every bgm id, templates resolve
python3 tools/gen_music.py caption <id>        # print the exact caption sent to the model
python3 tools/gen_music.py generate [ids]      # model -> assets_src/music/raw/<id>.wav (3 concurrent, 1 retry)
python3 tools/gen_music.py process  [ids]      # raw WAV -> loop -> loudnorm -> MP3 + ffprobe verification
python3 tools/gen_music.py docs                # refresh the track table below from captions + build report
python3 tools/gen_music.py all [ids] [--force] # everything above, then tools/build_manifest.py if present
```

Generation is idempotent: an existing raw WAV is skipped, and a `<id>.pending` marker (written while a job is
submitted) prevents resubmitting a running job. The model probes its endpoint before submitting; a failed probe
submits nothing. `generation.concurrency` is 1 because the hosted studio fails every job of a concurrent batch from
one token after ~60 s (`Music3 生成失败: {"error": null}`); single jobs take ~2 min. Failed jobs are retried
`retries` times after `retryDelaySeconds`.

The model decides the length itself: `durationSeconds` acts as an upper bound and instrumental takes come back at
roughly 55–85 s whatever is requested (verified: 110 s → 62 s, 120 s → 63–82 s, 240 s → 64 s; bar-timed section
plans and structure tags in `lyrics` did not lengthen them). Loops are therefore ~40–60 s for field/town/battle
tracks.

## Caption shape

The caption is rendered from `template` in `captions.json`: a one-line description followed by the three sections
the Music3 studio parses — `Global Metadata` (BPM, key, scale, meter, genre, emotional progression, imagery,
production, loop rule), `Vocal Details` (instrumental; names the lead instrument) and `Arrangement` (primary /
secondary instrument lifecycle, groove, textures, `[Section]` timeline). Shared style text (`style.*`) pins the HD-2D
JRPG / Octopath Traveler palette, forbids vocals and sound effects, and asks for a constant tempo with no ritardando
or fade-out so the material loops.

## Loop processing

1. Decode to 44.1 kHz stereo float, trim leading/trailing silence (`silenceThresholdDb`).
2. Cut the final ring-out: the musical end is the last point whose smoothed level is within `tailDropDb` of the
   track's median level.
3. Search a loop start `S` in the first `startSearchSeconds` and a loop end `E` in the last `endSearchSeconds`.
   Each pair is scored on the windows *before* both points (`similarityWindowSeconds`, the crossfaded material)
   and the short windows *after* both points (`followWindowSeconds`, what the ear expects next): chroma similarity
   (harmony), onset-envelope correlation (beat phase) and level difference, minus penalties for seams inside quiet
   passages (`quietPerDb`, below the track's median level) and for discarded material. Loops shorter than
   `minKeepRatio` of the track are rejected.
4. Refine `E` at 1 ms resolution by correlating transient envelopes so drums line up across the seam.
5. FFmpeg's MP3 decoder returns too many samples when the final MP3 frame carries fewer than
   `encode.minLastFrameSamples` samples (measured: loop lengths ≡ 1–47 mod 1152), so `E` is nudged back by up
   to that many samples (< 1.1 ms) when the loop length modulo `encode.frameSamples` would land there.
6. Output = `A[S : E−X]` followed by `A[E−X : E]` (fading out) mixed with `A[S−X : S]` (fading in), equal-power,
   `X = crossfadeSeconds`. The file's last sample continues directly into its first sample.
7. Two-pass `loudnorm` (I = −16 LUFS, TP = −1.5 dBTP) on a circularly padded copy so any dynamic gain state is
   identical on both sides of the seam. Linear (pure gain) mode is used whenever the true-peak ceiling allows;
   `preserveDynamics` raises the LRA target to the source LRA so loudnorm never compresses just to meet it. The
   target is re-aimed (up to `maxCorrections`) while the encoded MP3 is off by more than `aimToleranceLu`, unless
   that would force linear mode into dynamic mode; verification fails beyond `toleranceLu`.
8. Encode with libmp3lame (the LAME/Xing header carries encoder delay + padding for gapless decoding), then verify
   codec, sample rate, channels, bit rate, duration, integrated loudness (`toleranceLu`), encoded true peak
   (`maxEncodedTruePeakDb`) and that the decoded sample count equals the loop length exactly
   (`gaplessToleranceSamples`); record seam metrics (level jump across the seam and its percentile among all
   jumps in the file).

Chrome's `decodeAudioData` honours the LAME gapless header — decoded sample counts equal the loop length exactly
(check: serve the repo root, e.g. `python3 -m http.server`, and open `/sandbox/music_gapless.html`), so
`AudioBufferSourceNode.loop = true` (what `src/client/core/audio.ts` uses) loops seamlessly. An `<audio loop>`
element may add a small gap.

## Tracks

<!-- tracks:begin -->
| id | 名称 | category | BPM | key | requested | loop (MP3) | LUFS | caption summary |
|---|---|---|---|---|---|---|---|---|
| `title` | 标题 | title | 92 | D major | 120 s | 58.6 s | -16.4 | Orchestral JRPG main theme, HD-2D fantasy overture — Majestic yet warm main title theme for a pixel-art creature-collecting adventure across a world of friendly AI spirits. |
| `town` | 小镇 | town | 108 | F major | 110 s | 39.8 s | -16.4 | Acoustic folk JRPG town theme, pastoral waltz — Cozy, cheerful hometown theme for a small pixel village where trainers live alongside their AI companions. |
| `route` | 道路 | field | 120 | G major | 120 s | 45.5 s | -16.0 | Orchestral JRPG field theme, adventurous pastoral march — Upbeat adventuring theme for walking the grassy routes between towns, ready for encounters in the tall grass. |
| `forest` | 森林 | field | 84 | E minor with a Dorian colour | 115 s | 41.7 s | -16.4 | Celtic-tinged orchestral fantasy, JRPG forest theme — Mysterious, enchanted woodland theme for a dense forest where gentle AI spirits hide among ancient trees. |
| `desert` | 沙漠 | field | 100 | D Phrygian dominant | 110 s | 52.2 s | -16.0 | Middle-Eastern flavoured orchestral world music, JRPG desert theme — Sun-baked caravan theme for a vast sand sea where old server towers lie half-buried in the dunes. |
| `snow` | 雪山 | field | 76 | B minor | 115 s | 67.9 s | -16.0 | Chamber orchestral winter theme with music-box colour, JRPG field — Quiet, sparkling snowy-mountain theme for a frozen highland of glittering ice and drifting snow. |
| `coast` | 海岸 | field | 116 | A major | 110 s | 46.1 s | -16.0 | Celtic maritime folk, acoustic JRPG coastal theme — Breezy seaside harbour theme for sunny beaches and fishing piers along the coast. |
| `city` | 都市 | town | 118 | C major with a Mixolydian colour | 110 s | 46.2 s | -16.0 | Jazz-funk orchestral city theme with subtle synthwave colour, JRPG town — Stylish metropolis theme for a bustling high-tech capital where AI companies tower over neon-lit plazas. |
| `swamp` | 沼泽 | field | 88 | C minor | 110 s | 52.1 s | -16.0 | Quirky dark-whimsical orchestral, JRPG swamp theme — Murky, mischievous swamp theme for a foggy marsh full of bubbling pools and odd creatures. |
| `volcano` | 熔炉 | field | 128 | D minor | 110 s | 37.7 s | -16.0 | Driving industrial orchestral, JRPG volcano dungeon theme — Fiery forge-volcano theme for a region of lava rivers and giant furnaces where hardware is smelted. |
| `ruins` | 遗迹 | field | 80 | A minor | 115 s | 55.4 s | -16.0 | Ambient orchestral mystery, JRPG ancient ruins theme — Ancient ruins theme for crumbling temples of a forgotten computing civilisation. |
| `night` | 夜晚 | field | 72 | E-flat major | 115 s | 40.4 s | -16.0 | Gentle chamber orchestral nocturne, JRPG night theme — Calm night-time field theme when the overworld sleeps under the stars. |
| `center` | 补给站 | facility | 100 | C major | 60 s | 38.4 s | -16.4 | Gentle easy-listening chamber pop, JRPG healing centre theme — Warm, reassuring supply-station theme where trainers rest and restore their AI companions. |
| `lab` | 研究所 | facility | 108 | G major | 60 s | 38.0 s | -16.0 | Playful chamber orchestral with light electronic colour, JRPG laboratory theme — Curious, upbeat research-lab theme for the professor's AI laboratory. |
| `gym` | 道馆 | town | 132 | E minor | 105 s | 37.2 s | -16.0 | Orchestral rock, JRPG gym theme — Tense, determined gym-hall theme as challengers walk toward the gym leader. |
| `battle_wild` | 野生对战 | battle | 152 | A minor | 80 s | 56.7 s | -16.0 | Orchestral JRPG battle theme with rock drums — Energetic wild-encounter battle theme for when an AI creature jumps out of the tall grass. |
| `battle_trainer` | 训练家对战 | battle | 160 | D minor | 90 s | 44.1 s | -16.0 | Orchestral rock JRPG battle theme — Intense trainer-battle theme for duels against rival trainers and online opponents. |
| `battle_gym` | 道馆对战 | battle | 168 | E minor | 90 s | 51.3 s | -16.0 | Symphonic rock JRPG boss battle theme — Epic gym-leader battle theme for the decisive challenge for a badge. |
| `battle_legend` | 传说对战 | battle | 150 | C minor | 90 s | 45.4 s | -16.0 | Epic symphonic rock with dark electronic colour, JRPG legendary battle — Climactic legendary-creature battle theme against an ancient, colossal AI. |
| `victory` | 胜利 | jingle | 132 | B-flat major | 30 s | 21.8 s | -16.0 | Orchestral JRPG victory fanfare — Triumphant victory theme after winning a battle, short and loopable while the results are shown. |
| `evolution` | 进化 | jingle | 120 | C major | 30 s | 21.0 s | -16.0 | Magical orchestral JRPG evolution cue — Wondrous evolution theme as an AI creature transforms into a new form. |
| `cave` | 洞窟 | field | 78 | F-sharp minor | 115 s | 56.8 s | -16.0 | Ambient orchestral, JRPG cave dungeon theme — Echoing cave theme for deep caverns with crystal formations and underground lakes. |
| `sakura` | 樱花丘陵 | field | 92 | D major pentatonic | 115 s | 60.2 s | -16.4 | East Asian-flavoured chamber orchestral pastoral, JRPG field theme — Gentle springtime theme for rolling hills of blooming cherry trees and quiet bamboo groves where shy AI spirits play among falling petals. |
| `jungle` | 雨林 | field | 108 | G minor with a Dorian colour | 115 s | 43.8 s | -16.0 | Tropical world-percussion orchestral adventure, JRPG jungle field theme — Lively rainforest theme for steamy jungles and mangrove channels full of curious hidden creatures. |
| `glacier` | 冰原 | field | 72 | F# minor with a Lydian-tinged middle section | 115 s | 57.0 s | -16.0 | Atmospheric chamber orchestral winter theme with crystalline percussion, JRPG field — Vast, glittering theme for blue glaciers and windswept tundra under the aurora. |
| `canyon` | 峡谷荒野 | field | 100 | E Mixolydian | 115 s | 47.5 s | -16.0 | Frontier western acoustic orchestral adventure, JRPG wilderness field theme — Sun-baked frontier theme for red-rock canyons, striped badlands mesas, salt flats and golden savanna. |
| `cyber` | 数据荒原 | field | 112 | C# minor with a Dorian colour | 115 s | 33.1 s | -16.0 | Chiptune-infused electronic orchestral hybrid, JRPG digital frontier field theme — Curious digital-wilderness theme for glitched data wastelands, circuit-board plains and glowing neural forests. |
| `skyland` | 云海高原 | field | 88 | A Lydian | 115 s | 51.6 s | -16.0 | Airy orchestral fantasy with harp and woodwinds, JRPG sky highland field theme — Floating, dreamy theme for highlands above a sea of clouds and plateaus of glowing crystal. |
<!-- tracks:end -->
