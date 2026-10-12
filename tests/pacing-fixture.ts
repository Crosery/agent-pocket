import type { CreatureActor, GameContext } from '../src/client/contracts.ts'
import { CONTENT } from '../src/shared/content/index.ts'
import { Rng } from '../src/shared/rng.ts'
import { buildWorld } from '../src/shared/world/index.ts'
import { regionAt, terrainAt } from '../src/shared/world/worldapi.ts'
import { createCreature, healFull } from '../src/shared/creature.ts'
import { createSaveManager } from '../src/client/core/save.ts'
import { standable } from '../src/client/world/rarity-spawns.ts'

export const world = buildWorld()
export const overworld = world.maps[world.startMap]
const stubCreatureActor = (): CreatureActor => ({
  object: undefined as never, x: 0, y: 0, elev: 0, speciesId: '',
  setPosition() {}, setFacingLeft() {}, setMoving() {}, setVisible() {}, setShiny() {}, setAura() {}, bubble() {}, update() {}, dispose() {},
})

export function makeRuntimeRig(seed = 20261011) {
  const saves = createSaveManager({ world, storage: null })
  const avatar = CONTENT.characters.find((c) => c.playable) ?? CONTENT.characters[0]
  const save = saves.newGame({ name: '测试', avatar: avatar.id })
  const lead = createCreature('o1', 6, { rng: new Rng(seed) }, CONTENT)
  healFull(lead, CONTENT)
  save.party = [lead]
  let choice = 0
  let axis = { x: 0, y: 0 }
  const toasts: string[] = []
  const localWorld = { ...world, maps: { ...world.maps } }
  const ctx = {
    data: { ...CONTENT, world: localWorld },
    save,
    clock: { timeOfDay: 'day', minutesOfDay: 600, label: () => '10:00' },
    world: {
      map: null,
      async loadMap() {},
      createActor: () => ({
        setName() {}, setPosition() {}, setFacing() {}, setMoving() {}, setVisible() {}, hop() {}, bubble() {}, update() {}, dispose() {},
      }),
      createCreatureActor: stubCreatureActor,
      elevationAt: () => 0,
      spawnFx() {},
      setBeacons() {},
      setQuestPath() {},
      setGroundItems() {},
      setZoom() {},
      setWeather() {},
      update() {},
    },
    minimap: {
      exploredBits: () => null,
      setMap() {},
      setFogPages() {},
      reveal() {},
      update() {},
    },
    ui: {
      root: typeof document === 'undefined' ? undefined : document.createElement('div'),
      async say() {},
      async choose() { return choice },
      async confirm() { return false },
      toast(text: string) { toasts.push(text) },
      async fade() {},
      isBlocking: () => false,
    },
    hud: {
      overlay: typeof document === 'undefined' ? { style: { visibility: '' } } : document.createElement('div'),
      setRegion() {},
      setClock() {},
      setMoney() {},
      setQuest() {},
      setLead() {},
      setPrompts() {},
      setEvents() {},
      setLegendSense() {},
      showBanner() {},
    },
    input: {
      axis: () => axis,
      held: () => false,
      pressed: () => false,
      consume() {},
      onWorldTap: () => () => {},
    },
    net: {
      status: 'offline',
      send() {},
      reportPosition() {},
      setStepReplay() {},
      onCorrection: () => () => {},
      on: () => () => {},
      remotePlayers: () => [],
    },
    chat: { isOpen: false },
    audio: { currentBgm: '', playSfx() {}, playCry() {}, playBgm() {} },
    events: { emit() {}, on: () => () => {}, once: () => () => {} },
    renderer: { flash() {}, shake() {}, setTransition() {} },
    battle: { async run() { return { result: 'run', moneyDelta: 0 } } },
    screens: { async starter(o: { id: string }[]) { return o[0].id }, async shop() {}, async box() {} },
    persist() {},
  } as unknown as GameContext
  return {
    ctx,
    save,
    localWorld,
    toasts,
    setChoice: (i: number) => { choice = i },
    setAxis: (x: number, y: number) => { axis = { x, y } },
  }
}

/** Finds an open habitat spot in the overworld where tall grass and roaming encounters exist. */
export function findHabitatSpot(): { x: number; y: number } {
  const ctx = { data: { ...CONTENT, world } } as unknown as Pick<GameContext, 'data'>
  for (let r = 6; r < 90; r += 2) {
    for (let dy = -r; dy <= r; dy += 2) {
      for (let dx = -r; dx <= r; dx += 2) {
        const cx = overworld.spawn.x + dx
        const cy = overworld.spawn.y + dy
        const rg = regionAt(overworld, cx, cy)
        if (!rg || !rg.encounters.length || rg.roamingDensity <= 0.3) continue
        if (!standable(overworld, cx, cy, ctx)) continue
        let grassCount = 0
        for (let y = cy - 12; y <= cy + 12; y++) {
          for (let x = cx - 12; x <= cx + 12; x++) {
            const t = CONTENT.terrain[terrainAt(overworld, x, y)]
            if (t?.encounter) grassCount++
          }
        }
        if (grassCount >= 40) return { x: cx + 0.5, y: cy + 0.5 }
      }
    }
  }
  throw new Error('no habitat spot found near spawn')
}
