# World generator

`buildWorld(seed = CONTENT.config.world.seed)` (src/shared/world/index.ts) deterministically builds the
whole `World` — a 1024×1024 overworld, 2 story caves, 6–10 procedural dungeons (1–3 floors each) and every
interior — from the JSON under `content/world/**`. The code holds **no game data**: terrain/prop keys,
coordinates, names, word pools, texts, densities, level bands and every tuning number come from JSON; code only
references capability flags (`walkable`, `swim`, `stairs`, `liquid`, `collide`, `door`, `light`) and contract enums.
All noise and randomness is integer-hash based (`Math.imul`, `+ − × ÷`, `floor`, `sqrt` only), so client and
server build bit-identical worlds.

Story content (NPCs, trainers, quests, services) is layered on at the end of `buildWorld` by `applyStory()`
(story.ts, not part of the generator) using the anchors from `worldAnchors(world)`.

Default seed: **1024×1024**, 172 maps, ~88k props, 127 regions, 15 hamlets, 94 POIs, 9 dungeons, 74 wild
regions, ~1800 anchors, 300 + 150 ground items, **~1.7 s cold build** (Node, Apple Silicon), 0 problems.

## Public API

| export | from | purpose |
|---|---|---|
| `buildWorld(seed?)` | index.ts | build (or rebuild) the world |
| `worldAnchors(world)` | index.ts | `Record<name, {map, x, y}>` named spots for story content |
| `worldBuildInfo(world)` | index.ts | `{anchors, problems, walkReach, surfReach, features, buildMs}` (`problems` must be empty) |
| `worldStats(world)` | index.ts | `{width, height, maps, props, pois, hamlets, dungeons, regions, buildMs?}` |
| `WorldFeatures` (type) | index.ts | `hamlets[] pois[] dungeons[] wilds[] islands[] rivers lakes gates[]` — the procedural layer for tools/tests/world map |
| `frontier.*` | index.ts → frontier/index.ts | `FrontierProvider`, decorator registry, id helpers — see "Infinite frontier" |
| `validateWorldContent()` | index.ts | JSON reference check → error strings |
| `WORLD_CONTENT`, `scaleLayout(wc)` | index.ts | parsed world JSON; layout-space → tile-space scaling |
| `createNoise perlin simplex fbm ridged warp worley sampleField upsample latticeSize fbm01 smoothstep` | src/shared/noise.ts | seeded deterministic noise (pure functions, no globals) |
| `buildCollision, canStep, terrainAt, elevationAt, regionAt` | collision.ts | `CollisionApi` (named exports) |
| `propSize, propRect, propCenter, propDoor, stairsDir, isStairs, inBounds` | collision.ts | placement / stairs helpers shared with the renderer |

`World.towns` lists the 10 story towns (`kind: 'town'`), every hamlet (`'hamlet'`) and every landmark POI and
dungeon mouth (`'landmark'`), each with `levelRange`. **Consumers that mean "story town" must filter
`(t.kind ?? 'town') === 'town'`.**

## Overview (default seed, 1 char = 16×16 tiles)

```
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
~~~~~~~~~~~~~c~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
~~~~~~~~~~~~~~~~mmmmm~~s~~~~~~~s*~~~~~~~~~~~~~~~~~~~~~~~~c~~~~~~
~~~~~~~~~~~~~~~~~mmmmmssssss~rrrrrrss~~~~~~~~~~~~~~~~~~~~~~~~~~~
~~~~~~~~~~~~~~~~mm#Hmmssssssrrrrrrr^^s~~~~s~~ss~~~~~~~~~~~~~hh~~
~~~~~~~~~~~~~~~~~mmmmmssss*srrrrrrrr^ssssssssssh~~~~i~~cc~~hDh~~
~~~~~~~~~~~~~~~~mmmmmmssssssrrr##rr^^^ssssssssh*hi~iii~~~hhhhh~~
~~~~~~~~~~~~~~vvvvvmmmmssssssrr#9rr^^^sH#sssshhhhh~hiihhhhhhhh~~
~~~~~~~~~~~~vvvvvvvmmmssssssrrrrrrrrsss#ssshhhhhhhhhhhhhhhhhhh~~
~~~~~~c~~~mm*vvvvvvvmmmss*srrrrrrrrsssssssirrhhhhhhhhhhhhhhhhh~~
~~~~~~~~~mmvvvv#5ssv*m^^^^sssrrrrrrsssssiirrrrrhhhhhhhhhhhhhhh~~
~~~~~~~~~mDvvvvw#vssss^^^^^^^srrsssssssiirrrrrr~hhhhH#hhhhh*hh~~
~~~~~~~mmmmvvvwwvvvvms^^^^^^^srssssssssirrrrrrrrhhhh#hhhhhhhhh~~
~~~~~~~mmmm*mvwwvvvmm^^^^*^^ssrssssssssrrrr*rrriihhhhhhhhhhhhh~~
~~~~mmmm*mmmmwwvvvv^^^^~^^^ssrrssssssssrrrrrrriiiihihhhhhhhhhh~~
~~~~mm^^mmmmmwvvvv^^^^^^^^^ssrrssssssssr*rrrriiiiiiiihhhh*hhhh~~
~~~~fmmmmmmmmwvvwhh^^^^^^^sssssssssssssrrrrrrii###iiihhhhhhhhh~~
~~~fffvvmmmvvwvfhhh^^^H#^^ssssssssssssssssrrris#7#iiimhhhhhhh~~~
~~~fHfffff*vvwfffhhhh^#^^^s*ssrsssssssssssssssh###iiimmmmhhh~~~~
~~~f#fffffwwwwfffffff^^^^^^sss6#ssssssDs^mhhmm~hhiiiimmmmmh~~~~~
~~~fffffwwwwwwwffffff^^^^^^ssssssssssssssmhmmmiiiiii*mmmmm~~~~~~
~~~fffffwwwwwwwwfffff^^^^^sssssssssssssssmhmmiiiiimmmmmmmm~~~~~~
~~~ffffwwww##wwwfffffs*^^ssssssssssssssssmhmmmmimmmmmmmmm~~~~~~~
~~~ffffwwww4#wwwfffffssssssssssss*ssssssmhhmmmmmmmmmmmmDm~~~~~~~
~~~~ff~~wwwdwwwfffffffsssssssssssssssssshhmmmmmmmmmmmmmmm~~~~~~~
~~~~ff~~wwwdwwwwffffffsshhhhsssssssshsshhmmmmmmmmmmmmmmm~~~~~~~~
~~~ffffffwwdwwfffffffffhhh*hhssssshhhhhhmmmmmmmmm*mmmmmm~~~cc~~~
~~~*ffffffwdwwwffffff~mhhhhhhhhssshhhhhhmmmHmmmmmmmmmmm~~~~~~~~~
~~~wwwfffffdfffffffffmmhhhhhhhhhhhhhhh*hhmmmmmmmmffmmmm~~~~~~~~~
~~~wmmmm*ffdmfDfffffmmmhH#hhhhhhh*hhhhhhhmmmmmmmfffffmmmc~~~~~~~
~~~mmmmmmmmdmmmfffffmmmh##hhhhhhhhhhhhhhhhmmmmmffffffffm*~~~~~~~
~~mmmmmm~mmdmmmmmmmmmmhhhhhhhhhhhhhhhhhhhhhmmmmffffffffff~~~~~~~
~~mmH#m~~~m*mmm*mmmmddhhhhhhhhh#8hhhhhhhhhhhmmffffffffffcc~~~~~~
~~mmmmmmmmmdddmmmmmmmdhhh*hhhhhhhhhhhhhhhhh*mmmffff#Hfffcc~~~~~~
~~mmmmmmmddddddmmmmmmdhhhhhhhhhhhhhhhhhhhhh^^mmfffff#ffccc~~~~~~
~~~mmmmddddddddmmmmmmdhhhhhhhhhhhhhhh#Hhh^^^^mmffffffff~~~~~~~~~
~~~~mddddd##dddmmmmmmmhhhhhhhhhhhhhhhhhhh^^^mmffffffff~~~ccc~~~~
~~~~mmmddd3#ffdmm#mmmhhhhh~~~h*h^^hhhhhhhhhmmmf~fffff~~~~ccc~~~~
~~~~mmmddddfdfffmH#mmhhhhh~~~hh^^^hhhhhhhhh*mmfffffff~~~~~cc~~~~
~~~~mmdddddddddfffmmdhhhhhh~h^^^^^hhhhhhhhhmmm^^f*ffmm~~~~~~~~~~
~~~~m*mddd*ddddmmfmdmmmmmhmh^^^^^^hhhhhhhhhmmm^^^fffmm~~~~~~~~~~
~cc~mmmmmdmmmmmmmfmdmmmmmmmm^^^^^^hhhhhhhhmmmmmfffmmmm~~~~~~~~~~
~~~~mmmmmmmmmmmmmffmmmmmmmmmm^^^^hhhhhhh*hmmmmmmmmmmm~~~~~~~~~~~
~~~mmm~~mmmffffmDmffmmmmmmmmm^^hhhhhhhhhhhmmmmmmmmcmm~~~~~~~~~~~
~~~~mmmmmmfffffffffffffmmmmmmmmmmhmmmhhhmmmm#Hmmccccmmc~~~~~~c~~
~~~~~mmmmmfDffffffffffffmmmmmmmmmmmmmmmmmmmmmmccccccccc~~~~~~c~~
~~~~~*mmdffffffffffmmfffmmmmmmmmmHmmmmmmmmmmmmcccccccccc~~~~~~~~
~~c~~~mdffffffffff##mf*fmmmmmmmmm#mmmmmmmmmmmmcccc##cccc~~~~~~~~
~~~~~~~dffffffffff1#mmmmmmmmmmmmmmmmmmmmmmmmmmcccc2#cc*~~~~~~~~~
~~~~~~~dffffffffffffffmmmmmmmmmmmmmmmmmmmmmmmcccccccccc~~~~~~~~~
~~~~~~~fffff~fffffffffmmmmmmmmmmmmmmmmmmmmmcccccccccccc~~~c~~~~~
~~~~~~~ffff~~~fffffffmmmmmmmmmmmmmmmmmmmmcc~mmmf*ccccc~~~ccc~~~~
~~~~~~~ffff~~~mmmmfffmmmmmmmmmmmmmmmcccccccmfmffffffff~~~cc~~~~~
~~~~~~~~fff~~mmmmmmmm*mmmmmDmmmmmmmccmmm*mmmfffffffff~~~~~~~~~~~
~~~~~~~fffffm#Hmmmmmmmmmmmmmmmm#0cccmmmmmmmmmffffffH#f~~~~~~~~~~
~~~~~~~~fffmm##mmmmmmmmmfmmmmmm##mmmmmmmmmmmmmfffff#ff~~~~~~~~~~
~~~~~~~~*f~mmmmmmmmmmmmfmmmmmmmmmmmmmmmmmmmmmmffffmmmc~~~~~~~~~~
~~~~~~~~~~~~mmmmmmmmmmmmmmmmmmmmmmmmmmm~mmmmmmmfmmmmmc~~~~~cc~~~
~~~~~~~c~~~~m~~~m*mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmc~~~~~c~~~~
~~~~~~~~~~~~m~~~~~mmm~~~~~*mmmm~m*mmmmmmmm~~~~mmmm*mm~~~~~~~~~~~
~~~~~~~~~~~mm~~~~~~~~~~~~~~~~~~~~~mmmmmDm~~~~~~~~~m~~~~~~~~~~~~~
~~~~~c~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
~~~~~~~~~~~~~~~~~h~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
```

`m` meadow · `f` forest · `d` desert · `s` snow · `c` coast · `i` city · `w` swamp · `h` highland · `v` volcano ·
`r` ruins · `~` water · `#` town ground · `^` elevation ≥ 9 · `0`–`9` story towns (table below) · `H` hamlet ·
`D` dungeon mouth · `*` landmark POI.
Regenerate: `node sandbox/world-ascii.ts 16 [seed]` (also prints all tables). PNG views:
`node sandbox/world-png.ts /tmp/ap-world 1 overworld` → `overworld.png`, `-regions.png`, `-elev.png`, `-reach.png`
(`SEED=n` for another seed, `CROP=x,y,w,h` + a larger scale for close-ups).

Levels 0..12. One continent with a noisy, round-cornered coast and bays, a 26-tile ocean ring, 3 authored +
14 procedural surf-only islands. Mountain ranges (ridged noise) and snowcaps in the north and centre, plateaus
and canyons in the wilds, ~20 rivers flowing downhill to the sea or into lakes (bridged where routes, trails and
access repairs cross), 6 authored lakes + basin lakes, beaches on low coasts and cliffs along snow/city/highland/
ruins shores.

### Towns

| # | town | id | region | square (x,y) | levels | gym |
|---|---|---|---|---|---|---|
| 0 | 原点镇 | origin | meadow | 513,877 | 2-6 | - (start, player house, lab) |
| 1 | 开源林镇 | opensource | forest | 298,770 | 4-10 | code (badge-code) |
| 2 | 像素港 | pixelport | coast | 815,770 | 8-14 | vision (badge-vision) |
| 3 | 和弦沙城 | chord | desert | 172,599 | 13-19 | sound (badge-sound) |
| 4 | 检索遗都 | retrieval | swamp | 187,374 | 18-25 | search (badge-search) |
| 5 | 熔炉镇 | forge | volcano | 262,172 | 24-31 | compute (badge-compute) |
| 6 | 霜盾城 | frostshield | snow | 492,315 | 30-37 | safety (badge-safety) |
| 7 | 枢纽市 | hub | city | 781,284 | 36-42 | agent (badge-agent), data tower 1F–3F, datacenter |
| 8 | 衡理镇 | balance | highland | 514,523 | 42-48 | logic (badge-logic) |
| 9 | AGI 圣殿 | agi | ruins | 513,113 | 50-58 | - (temple, champion) |

### Routes

| route | name | from → to | levels | trainer spots | gate |
|---|---|---|---|---|---|
| route-1 | 1 号道路 | origin → opensource | 3-7 | 6 | - |
| route-2 | 2 号道路 | origin → pixelport | 7-12 | 7 | - |
| route-3 | 3 号道路 | opensource → chord | 11-16 | 7 | - |
| route-4 | 4 号道路 | chord → retrieval | 16-22 | 7 | - |
| route-5 | 5 号道路 | retrieval → forge | 22-28 | 7 | - |
| route-6 | 6 号道路·霜脊山口 | forge → frostshield | 28-34 | 7 | gate:snowpass (349,193) |
| route-7 | 7 号道路 | frostshield → hub | 34-40 | 7 | - |
| route-8 | 8 号道路 | hub → balance | 40-46 | 9 | - |
| route-9 | 9 号道路·圣殿参道 | frostshield → agi | 48-55 | 5 | gate:ruins (491,211) |

Zone level bands (core regions): meadow 2-6, forest 4-10, coast 8-14, desert 13-19, swamp 18-25, sea 20-30 (surf),
volcano 24-31, snow 30-37, city 36-42, highland 42-48, ruins 50-58. Caves: 回响洞窟 `cave-echo` (desert ⇄ swamp,
lv 18-25), 晶核洞窟 `cave-core` (city ⇄ highland, lv 40-46).

### Progression

- Every story zone is walled (1×1 colliding border props; rocks through the shallows, rapids on deep rivers and
  lakes, cliffs on 'cliff' shores). Route paths and the two story caves are the only crossings, so the story
  order is unchanged; `gate:snowpass` / `gate:ruins` remain 1-tile choke points even with surf (tested).
- The wilderness inside a zone is optional: hamlets, POIs and dungeons hang off the route network by trails
  (`hamlets.road`), wild regions get harder with their distance from the zone core (danger tiers 0–2) and with
  their distance from the start town (`wilds.levels`), dungeon floors add `levelPerFloor` per floor.
- Every town, hamlet, dungeon mouth and non-island landmark is reachable on foot from spawn with gates open;
  island POIs and islands are surf-only (tested).

## Pipeline

**Macro** (macro.ts, all fields on the 4-tile lattice where possible, bilinear upsampled):

1. *Layout*: authored coordinates (256×256 design grid) are scaled into `layout.box` (`scaleLayout`).
2. *Zones*: warped Voronoi over the regions' control points; towns claim their surroundings; after the coast is
   known, zone fragments that lost land contact with their zone join the neighbour they border most.
3. *Core / wilderness*: distance to towns and each zone's first point → `wildness` (smoothstep + jitter noise).
   Core keeps the authored biome; the wilderness is classified by climate.
4. *Climate*: temperature (fbm + latitude − lapse·level), moisture (fbm, boosted near rivers/lakes) and
   weirdness noise, each contrast-stretched and blended toward the zone's `climate {t, m, w}` (blurred). A
   Whittaker-style rule table (`climate.json rules`, first match) maps them to biomes.
5. *Height*: blurred zone levels + relief + wildness × (hills + ridged mountain ranges under a mask + plateau
   steps − canyons in dry areas, domain-warped) + ridges along walled borders + authored peaks.
6. *Sea*: edge/circle falloff + coast noise vs threshold, hard `ocean.margin`, inland pockets filled, one
   continent; authored + procedural islands; beaches on low coasts, cliffs on 'cliff' shores.
7. *Pads*: authored lakes, town pads and site pads (hamlets, POIs, dungeons chosen on a jittered lattice by
   `sites.ts`) are flattened. Each pad level is clamped to the slope envelope of the sea, the authored lakes,
   the towns and the other pads, so no two flattened groups ever form a cliff > 1.
8. *Hydrology* (hydro.ts): coarse priority-flood with D8 flow and moisture-weighted accumulation; deep basins
   become lakes (shores follow the terrain, never next to a pad); river chains from accumulation heads,
   monotone water level, meandered + smoothed (Catmull-Rom) and carved into the height field.
9. *Levels*: slope-limited lower envelope (`slope` per tile) → pads ramped back up where rivers cut in →
   integer levels; walkable/swimmable neighbours differ by ≤ 1 everywhere.

**Overworld** (overworld.ts): base terrain → authored rivers (A*, moving-average smoothed) → story towns →
border bands → routes (A*, bridges, one-level stairs, gates, signs) → unused exits stubbed → story cave mouths →
hamlets (layout grammar) + trails → POIs → dungeon mouths + trails → biome terrain layers (noise thresholds) →
access stairs → border walls → access repair → prop scatter (noise-thresholded grass/flowers/forests) → access
repair with forced feature targets → wild regions → RegionDefs + encounters → trainer/quest/region/island/wild
anchors → POI items → remaining ground items. Interiors (story + hamlet doors), caves and dungeon floors are
built from their own layouts / cellular automata / drunkard walks.

### Procedural features

| feature | data | what is generated |
|---|---|---|
| hamlets | `pois.json hamlets` | 12–16 villages in the wilds: plaza + centre prop, 3–7 buildings on a ring facing the plaza with lanes, fenced crop fields with a gate gap, decor, a lore sign, 4 NPC spots; 40 % get a centre + shop. Doors warp into `layouts/interiors.json` templates. |
| POIs | `pois.json templates` | campsite, ruins, shrine, monolith, datacenter, crystal field, oasis, hot spring, lighthouse, dock, windmill, grove, shipwreck, treasure cache, rare-spawn nest (own region, `rareBoost`), trainer camp: ground blobs + prop parts (center/ring/scatter/grid/water), lore sign, NPC spots, items. Landmarks are listed in `World.towns`. |
| dungeons | `dungeons.json` | 7–9 sites (one may be dropped if no mouth fits), 1–3 floors each, style by biome (`ca` caves / `walk` drunkard-walk mines and ruins), stairs prop + warps between floors, boss spot on the last floor, items per floor, mouth sign "{dungeon} 共 N 层 · 推荐 Lv.X+". A floor whose floor area connected to its entrance is below `minFloor` × map area (single-end last floors have no end-to-end tunnel) gets a tunnel to its biggest chamber. |
| wild regions | `wilds.json` | each zone's wilderness split by warped Worley cells (≥ `minArea`), named from biome word pools, danger tier by distance from the core, level range by zone + tier + distance from the start town, biome music/weather, encounters with rare boost. |
| islands | `world.json archipelago` | procedural surf-only islands (`isle-<n>`) away from the coast. |
| items | `items.json` | 300 visible + 150 hidden across all maps (story caves and dungeon floors take their share). |

## Infinite frontier

The overworld map returned by `buildWorld` carries `map.infinite: ChunkProvider` (a `FrontierProvider`,
src/shared/world/frontier/). The finite arrays still hold the core continent (0..1023²) for legacy code; new
code reads tiles/objects through WorldApi (worldapi.ts), which works at any integer coordinate, negatives too.

**Coordinates.** World tile (x, y); chunk (cx, cy) = (⌊x / 64⌋, ⌊y / 64⌋) (`gen.json chunkSize`, must divide
the core size). Chunks fully inside the core are cut from the finished core map (story NPCs included, objects
bucketed by anchor chunk). Every other chunk is a pure function of `(seed, cx, cy)` — order-independent, seams
match (each chunk evaluates a 2-tile margin from global functions; site layouts and road edges are global
objects keyed by site cell). Origin = overworld spawn; distance from it drives levels, danger and rarity.

**Pipeline per chunk** (chunk.ts): lattice climate/landform fields (fields.ts: continent + archipelagos + a moat
around the core, temperature/latitude/lapse, moisture, weirdness (grows with distance), volcanism, erosion,
ridged mountains with passes, plateaus, canyons, warped-noise rivers with valleys, lakes) → biome by first-match
climate rules (`frontier/biomes.json`; 30 biomes in total, sea rules for shoals) → site pads + graded roads (base.ts) → site
layouts (layout.ts, reusing the core hamlet / POI grammars in a local window) → natural stairs / one-way ledges on
level contours → biome terrain layers → prop scatter (+ sea stacks, rapids) → regions → decorators.

**Geography.** Open sea and shoals around the core, archipelagos, new continents; mountain ranges with passes,
plateaus, canyons, ledges (`TerrainDef.ledge`, drop one level one way), rivers (deep = surf, narrow = fordable
shallows) that run into the sea, lakes, rapids props on river steps, sea stacks, cave mouths, hot springs /
oases / calderas as POIs. Four causeways (`gen.json causeways.specs`) run from early-game coasts of the core to
the core edge (stamped as the last overworld stage, so nothing else in the core changes); frontier lanes continue
to gateway hamlets (forced landfall, organic coast) and an onward causeway links each gateway to the frontier
road network. Roads: Z-shaped edges between road-bearing sites (east/south neighbours, gaps skipped), graded so
level changes only happen on straight land stretches with stairs on the lower tile, bridges over water.

**Sites** (sites.ts, `frontier/sites.json`): one per 112-tile cell at most — hamlet (houses, optional centre +
shop; gateway hamlets always have services), dungeon (1–4 floors), ruins / shrine / stele / rare-spawn nest /
landmark from a pool of 19 POI templates (8 frontier-only), or nothing; weighted by biome and distance.

**Regions** (regions.ts): provinces = warped Voronoi cells (300 tiles) with procedural names; region =
province × biome, id `fr:<px>:<py>:<biome>`; danger tier and level band from `gen.json levels` (distance curve);
encounter tables from the biome's `encounterHabitats`, rare boost by danger. Rarity tiers enter a table only from
`RarityBehavior.minDistance` and only if they spawn in the wild (`grass`/`visible`); the per-distance weight and
grass/visible multipliers are applied at spawn time by gameplay/spawns.ts (not baked in twice). Hamlet pads are
safe town regions (id = site id, `isTown`, `flySpawn`); nest tiles use `<siteId>:nest`.

**Ids** (stable, parseable with `frontier.parseFrontierId`):

| id | what |
|---|---|
| `fx:<kind>:<sx>:<sy>` | site / place (`kind` = `sites.json kinds[].id`, `sx, sy` = site cell) — `provider.place(id)`, `MapChunk.places` |
| `fx:hamlet:<sx>:<sy>:<slot>` | hamlet interior (`center`, `shop`, `house1`…) — `provider.interior(id)` / `getMap(world, id)` |
| `fx:dungeon:<sx>:<sy>:<floor>` | dungeon floor (1-based); item ids `<floorId>:item:<n>` |
| `fr:<px>:<py>:<biome>` | frontier region; `fx:…:nest` nest region; hamlet region = site id |
| `fx:<kind>:<sx>:<sy>:villager-<n>` · `<interiorId>:nurse/box/clerk/resident` | NPC ids |
| `fi:<cx>:<cy>:<n>` | wild ground item |
| `road:<siteA>><siteB>` · `road:<gate>` · `road:<gate>:onward` | road edges |

**Provider API** (beyond `ChunkProvider`): `generate(cx, cy)` (uncached), `inCoreChunk`, `decorSite(site)`
(layout + place + centre region), `siteOf(id)`, `placesIn(x0, y0, x1, y1)` (world-map pins without generating
chunks), `invalidateCore()` (after mutating the core map at runtime), `clearCache()`, `distance(x, y)`;
`fields` / `grid` / `roads` / `regions` for tools. `sample(x, y)` is exact inside the core and for resident
chunks, otherwise the natural column (no roads / layers) — deterministic, independent of cache state. `retain`
evicts chunks and sample sheets; all caches are LRU (`gen.json cache`).

**Decorators** (decorate.ts): `registerChunkDecorator(id, fn, order)` / `registerInteriorDecorator(id, fn,
order)` / `unregisterDecorator(id)`. Chunk decorators get `ChunkDecorContext` (chunk under construction, sites
with layouts, road edges, `isFree / isWild / occupy / regionAt / distance / rng(salt)`) and may add objects
anchored inside the chunk; interior decorators get the generated map, its anchors (`entrance`, template anchors,
dungeon `spot-<n>` / `boss`), floor and region. Built-ins: `fx-villagers`, `fx-signposts`, `fx-items`,
`fx-services` (nurse / box / shop by distance tier), `fx-residents`. Decorators must be pure (use `ctx.rng`);
register at module load, or call `provider.clearCache()` afterwards. `ctx.lookup` (`FrontierLookup`) gives
global read-only queries (`siteAt`, `decorSite`, `region`, `edgesNear`, `distance`) for cross-site links.

**Frontier content** (frontier/content/, `content/world/frontier-content/*.json`): replaces `fx-villagers` /
`fx-residents` and adds `fxc-landmarks`, `fxc-wild` (chunk) and `fxc-dungeon` (interior). Hamlets get bounty
givers + a board (story `content/world/story/bounties.json` kinds, personas, texts and reward table, read-only),
a courier (inbound deliveries, neighbour bearings) and archetype villagers (biome / distance lines, gameplay-core
`rumor:<event>` gossip, MYTHIC chain sages, rarity tips, gifts). Landmarks: guardians (`<site>:guardian`),
keepers (lore + `revealPlace` clues), watchers (`research`), hermits (chips for caught-type counts), rare
merchants (`ifTime` / `ifWeather`); dungeons get a boss (`<site>:boss`). Wilds: bounty outlaws by the road,
wandering trainers `ft:<cx>:<cy>:<n>` (class by biome, team by distance), milestone / border plaques, hermit /
merchant camps `fh:` / `fm:<cx>:<cy>`, caches `fi:<cx>:<cy>:c0`. Every object is a pure function of its site or
chunk; the chunk containing an object's anchor places it. Trainers / bounties live outside `world.trainers` /
`world.quests`: resolve them with `frontierTrainer`, `frontierQuest`, `registerFrontierRefs(world, npcs)` and
`restoreFrontierQuests(world, save)`; `frontierPlaceRefs` maps a place to event `nearPlace` refs.

**Performance** (Node, Apple Silicon): ~2 ms per 64² chunk after JIT warm-up (first chunks of a process 4–6 ms),
site layout ~1.3 ms, a 3-floor dungeon ~5 ms, 256² `sample()` ~40 ms cold / ~13 ms warm, ~18 MB for 320 cached
chunks. Budgets are asserted in tests/frontier.test.ts.

**Content files**: `content/world/frontier/gen.json` (chunk size, caches, lattice, continent / height / climate /
rivers / lakes / ledges / levels / provinces / roads / causeways / encounters / rarityDefaults / decor),
`biomes.json` (`rules`, `seaRules`, per-biome `beach ledge road stairs ledgeThreshold music weather encounterRate
roaming`), `sites.json` (`cell margin probe kinds landmarkPool templates lore hamlet gateway dungeon pad
poiWindow`), `names.json` (province / region name pools), `decor.json` (villagers, signposts, items, services,
residents, placeDescriptions). New biomes live in `content/biomes.json` (with `encounterHabitats`), their terrain
in `content/terrain.json`, scatter rules in `content/world/scatter.json` (`scale` / `variant` on prop rules).

## Conventions shared with the renderer / controller

- **Prop placement**: `PropPlacement (x, y)` is the top-left tile of the *rotated* footprint. `rot` = quarter
  turns counter-clockwise seen from above (three.js `rotation.y = rot·π/2`). Facade faces south at rot 0,
  east at 1, north at 2, west at 3; rot 1/3 swap footprint w/d (`propSize`).
- **Doors**: `PropDef.door` is an offset from the footprint centre tile `(floor(w/2), floor(d/2))` at rot 0,
  pointing to the tile *in front of* the door. The door warp sits on the facade tile behind it — the only
  enterable tile of a building. Interior exits return the player onto the front tile facing away from the door.
- **Stairs**: a stairs tile stores the *lower* level; exactly one orthogonal neighbour is one level higher
  (`stairsDir`). Elevation changes only along that axis; diagonals need equal elevation, no stairs, and both
  corner tiles passable.
- **Collision** (`buildCollision`): 0 free, 1 blocked, 2 water (needs surf). Warp tiles are always enterable.
- **Ledges** (`TerrainDef.ledge`): the ledge tile is the upper lip; stepping off it orthogonally drops one level,
  never back up. Generation can leave closed pockets below a ledge (props / cliffs / water around them), so the
  client refuses drops into pockets the player could not walk out of (src/client/world/ledge-guard.ts, tunables
  `content/explore.json ledge.guard`); the shared `canStep` rule itself is unchanged (server, NPCs).
- **Lights** are derived from `PropDef.light` for every placed prop (`map.lights`).
- **Ground items**: ids `gi-<n>` unique across all maps; never `key` category; on reachable walkable tiles.
- **Regions**: overworld region index is 8-bit (≤ 256 regions; ~127 used). Wild `RegionDef`s carry an extra
  `danger` number (0..tiers-1) until the contract adds it.

## Anchors (`worldAnchors`)

| pattern | where |
|---|---|
| `spawn` | overworld, in front of the player's house (= `town:origin:home`) |
| `town:<town>` / `town:<town>:square` | town square |
| `town:<town>:<slot>` | tile in front of building `<slot>` (`center`, `shop`, `gym`, `lab`, `home`, `house<n>`, `tower`, `datacenter`, `temple`) |
| `town:<town>:<anchor>` | template anchors: `npc-<n>`, `professor`, `rival`, `home-yard`, `gate-west/east`, `dock`, `tower-guard`, `plaza-north/south`, `guardian`, `camp`, … |
| `town:<town>:exit-<north\|south\|west\|east>` | town edge exits |
| `<town>-<slot>:entrance` | interior arrival tile (non-gym buildings: map id `<town>-<slot>`) |
| `<town>-<slot>:<anchor>` | center: `nurse counter pc pc-front npc-1..3`; shop: `clerk counter npc-1..2`; house: `resident-1..2 tv pc`; home: `mom wake bed pc pc-front tv tv-front`; lab: `professor aide-1..2 rival starters starters-front machine pc pc-front`; datacenter: `engineer-1..2 core` |
| `gym-<type>:leader`, `:trainer-1..3`, `:guide`, `:arena`, `:entrance` | 8 gyms |
| `data-tower-1f:…` · `data-tower-2f:…` · `data-tower-3f:…` · `agi-temple:…` | hub data tower, AGI temple |
| `gate:snowpass`, `gate:ruins` | gate choke tiles |
| `route:<routeId>:<n>` | 62 route trainer spots (1–2 tiles off the path, spaced) |
| `quest:1` … `quest:18` | quest spots (near the JSON hints, reachable) |
| `region:<regionId>`, `island:<islandId>` | one reachable tile per story zone / per island (authored + `isle-<n>`) |
| `<caveId>:mouth-<a\|b>`, `<caveId>:entrance-<a\|b>`, `<caveId>:1..6` | story caves |
| `hamlet:<id>` · `hamlet:<id>:<slot>-door` · `hamlet:<id>:npc-<n>` | hamlet plaza, tile in front of each door (`center`, `shop`, `house<n>`), 4 NPC spots; interiors are `<id>-<slot>:<anchor>` like towns |
| `poi:<id>:center` · `poi:<id>:spot:<n>` | POI centre and NPC spots (`<id>` = `<template>-<k>`) |
| `dungeon:<id>:mouth` · `dungeon:<id>:floor<n>:entrance` · `dungeon:<id>:floor<n>:spot:<k>` · `dungeon:<id>:floor<last>:boss` | dungeon mouth (overworld), floor arrival, floor spots, guardian spot |
| `wild:<regionId>:<n>` | ≥ 200 spots spread over the wild regions (240 by default) |

Anchors are on walkable tiles or (object anchors such as `pc`, `tv`, `nurse` behind a counter) next to one, and
reachable (surf for islands). NPCs standing on all spots never seal a warp, a gym leader, a town or a hamlet (tested).

## Content files

| file | shape |
|---|---|
| `content/world/world.json` | `overworld` (size, `layout {width height box}`, `coarse`, levels, `warp blur relief landforms`, `ocean archipelago beach cliffWidth`, islands/lakes/rivers, `riverRouting`, `hydrology`, `shallowBorder`, routing costs, gate/sign/cave/spot/access tuning), `encounters`, `text` (sign templates incl. `dungeonSign`) |
| `content/world/climate.json` | `temperature {noise contrast latitude lapse}`, `moisture {noise contrast water}`, `weirdness`, `bias {blur core wild weird}`, `core {radius jitter noise threshold}`, `rules[{biome t? m? weird? elev? sea?}]` (first match; last = fallback) |
| `content/world/regions.json` | story zones: `id nameZh biome music weather levelRange encounterRate roamingDensity level relief accessStairs points[]` (+ `water`, `border`, `peaks[]`, `climate {t m w}`, `shore`) |
| `content/world/wilds.json` | `cell jitter warp minArea maxRegions idPattern names{biome: {prefix suffix}} dupPattern tiers[{minDist levelBonus encounterRate roamingDensity rareBoost}] levels spots biomeMusic biomeWeather` |
| `content/world/pois.json` | `siteStep flatMax`, `hamlets {…}`, `templates{id: {names biomes count radius spacing site wildMin ground parts spots sign items landmark nest}}`, `lore {templates words biomeWords}` |
| `content/world/dungeons.json` | `count floors spacing minTownDist mouthProp stairsProp floorName levelPerFloor encounterRate roamingDensity spotsPerFloor items tunnelNoise rareBoost minFloor styles[{id biomes names size algo walk? floor wall wallElev mat CA params tunnelCost accents props music weather habitats}]` |
| `content/world/towns.json` · `routes.json` · `scatter.json` · `items.json` · `layouts/*.json` | unchanged shapes (story towns, routes, per-biome terrain layers/props/border props, item counts/bands, grid layouts) |

All JSON is formatted with `python3 tools/content_fmt.py <files>`.

## Tuning guide (JSON only)

| want | change |
|---|---|
| bigger / smaller world | `world.overworld.width/height` + `layout.box` (authored layout scales with it); keep build time in mind (~1.7 s at 1024²) |
| more / fewer bays, rounder island | `ocean.amplitude` (coast noise weight), `ocean.width` (falloff), `ocean.round`, `ocean.noise.scale` |
| more mountains | `landforms.mountains.maskRange` (lower = more ranges), `.amplitude`; snow line: `climate.temperature.lapse`, snow rule `t` |
| more rivers / lakes | `hydrology.riverThreshold` (lower = more), `widthStep`, `meander`; `lakeDepth`, `lakeMinCells`, `maxLakes` |
| stronger zone identity in the wilds | `climate.bias.wild` (0 = pure noise, 1 = zone climate), `bias.blur` |
| more biome variety | `climate.*.contrast`, the rule thresholds |
| larger story cores | `climate.core.radius`, `core.threshold` |
| more hamlets / POIs / dungeons | `pois.hamlets.count`, `templates.<id>.count`, `dungeons.count` (plus `spacing`, `siteStep`) |
| harder wilderness | `wilds.tiers[].levelBonus`, `wilds.levels.perTile`, `dungeons.levelPerFloor` |
| new POI kind | add `pois.templates.<id>` (props must exist in `content/props.json`; sign key in `lore.templates`) |

## How to add a town (JSON only)

1. Pick or add a layout in `content/world/layouts/towns.json` (`templates.<id>`): grid rows, `square`,
   `exits`, `buildings[{slot, prop, x, y}]` (prop must have a `door`), `signs`, `anchors`.
2. Add the town to `content/world/towns.json`: `id`, `nameZh`, `description`, `region`, `x`,`y` in layout space
   (256×256 design grid), `layout`, `music`, `palette`, `buildings{slot: {interior}}` (`{floors, mapId}` for
   multi-floor), `signs{slot: text}` and optionally `gym{type, badge, badgeNameZh, leader}`.
3. Connect it with a route in `content/world/routes.json`.
4. Run `node --test tests/world.test.ts` and check visually with `node sandbox/world-png.ts`.

## Verification

```
npx tsc --noEmit -p tsconfig.json
node --test tests/world.test.ts tests/frontier.test.ts tests/frontier-content.test.ts tests/content.test.ts tests/overworld.test.ts
```

tests/frontier-content.test.ts covers: the content pack validates; content determinism across a fresh provider
and another generation order; NPCs / items on free tiles, never sharing one; every referenced trainer / quest /
item resolves (teams: size, species, legal form at level, no legends / starters / duplicates); resolvers rebuild
from ids in a fresh world; bounty cross-links (courier inbound, outlaws, travellers, givers); level / size /
rarity scaling with distance; guardians, dungeon bosses, residents, place refs; rumor / clue / chip ops.

tests/frontier.test.ts covers: provider attached and JSON-safe, causeways reachable from the spawn, ≥ 24 biomes all
specified and generated, chunk determinism / order independence / negative coordinates, core chunks identical to
the core map, WorldApi parity (tiles, regions, collision, steps) between the infinite and the finite core, seams
(chunk elevations = one big base area), on-foot reachability core → causeways → gateway hamlets → frontier
hamlets, no stranding objects and warp round trips, hamlet interiors + services, multi-floor dungeons linked and
walkable, region levels / rarity gating / nests, decorators, `sample()` / `retain()`, and the perf budgets.

tests/world.test.ts covers: JSON references, determinism (same seed → identical maps/anchors; another seed
builds problem-free), build budget (cold < 4 s, warm < 3 s), 1024² size and ≤ 256 regions, `worldStats`, warps
valid/walkable/not chained, door ⇄ exit pairs (towns and hamlets), no foreign prop on warp tiles, towns +
hamlets + dungeon mouths reachable on foot (island POIs surf-only), islands surf-only, gates are choke points,
start region enclosed, anchor coverage (incl. hamlet/POI/dungeon/wild anchors, ≥ 200 wild) and validity, NPC
spots never seal warps/leaders/towns, encounter tables, elevation steps ≤ 1 and stairs direction, feature counts
within the JSON ranges and unique names, dungeon floors chained and walkable to stairs/boss, wild regions
(encounters, danger tiers raise levels, biome variety), terrain variety, ground items, signs, and CollisionApi
on synthetic maps. Seeds 1–16 were additionally checked for 0 problems and 0 cliffs.
