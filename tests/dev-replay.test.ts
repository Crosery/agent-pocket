// Input recording and scripted playback at the Input interface: what a frame saw is what it replays.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Input, InputAction } from '../src/client/contracts.ts'
import { ACTIONS, axisFrames, createInputTap, holdFrames, pressFrames, type Frame } from '../src/client/dev/replay.ts'

/** A scriptable stand-in for the real Input: per frame it returns what the test dictates. */
function fakeInput() {
  let state = { x: 0, y: 0, held: new Set<InputAction>(), pressed: new Set<InputAction>(), repeat: new Set<InputAction>(), released: new Set<InputAction>() }
  const consumed: InputAction[] = []
  let frames = 0
  const input: Input = {
    axis: () => ({ x: state.x, y: state.y }),
    held: (a) => state.held.has(a),
    pressed: (a, repeat = false) => (repeat ? state.repeat.has(a) : state.pressed.has(a)),
    released: (a) => state.released.has(a),
    consume: (a) => { consumed.push(a) },
    endFrame: () => { frames++ },
    setTextInputActive: () => {},
    lastDevice: 'keyboard',
    setTouchControlsVisible: () => {},
    refreshTouchLayout: () => {},
    onWorldTap: () => () => {},
  }
  return {
    input, consumed, get frames() { return frames },
    set(s: Partial<typeof state>) { state = { ...state, ...s } },
  }
}

const reads = (i: Input) => ({ axis: i.axis(), held: ACTIONS.filter((a) => i.held(a)), pressed: ACTIONS.filter((a) => i.pressed(a)), repeat: ACTIONS.filter((a) => i.pressed(a, true)), released: ACTIONS.filter((a) => i.released(a)) })

test('action list covers every InputAction (compile-time exhaustive) and masks fit a number', () => {
  assert.ok(ACTIONS.includes('confirm') && ACTIONS.includes('debug'))
  assert.ok(ACTIONS.length <= 31)
  assert.equal(new Set(ACTIONS).size, ACTIONS.length)
})

test('recording snapshots each frame once, whatever the reads and their order', () => {
  const f = fakeInput()
  let dt = 1 / 60
  const tap = createInputTap(f.input, () => dt)
  tap.record()
  f.set({ x: 1, y: 0, held: new Set(['right', 'run']) })
  assert.deepEqual(tap.axis(), { x: 1, y: 0 })
  assert.ok(tap.held('run') && tap.held('right') && !tap.held('left'))
  tap.endFrame()
  dt = 1 / 30
  f.set({ x: 0, y: -0.5, held: new Set(['up']), pressed: new Set(['confirm']), repeat: new Set(['confirm', 'up']), released: new Set(['run']) })
  assert.ok(tap.pressed('confirm'))
  assert.ok(tap.pressed('up', true))
  assert.ok(tap.released('run'))
  assert.ok(tap.pressed('confirm'), 'asking twice changes nothing')
  tap.endFrame()
  tap.endFrame() // a frame nobody read is not recorded
  const frames = tap.stop()
  assert.equal(frames.length, 2)
  assert.deepEqual(frames[0].slice(0, 3), [1 / 60, 1, 0])
  assert.deepEqual(frames[1].slice(0, 3), [1 / 30, 0, -0.5])
  assert.equal(f.frames, 3, 'the real input still ends every frame')
  assert.equal(tap.recording, false)
})

test('playback replaces the real input frame by frame, resolves after the last, and round-trips a recording', async () => {
  const f = fakeInput()
  const tap = createInputTap(f.input, () => 0.02)
  tap.record()
  const states = [
    { x: 1, y: 0, held: new Set<InputAction>(['right']), pressed: new Set<InputAction>(['right']), repeat: new Set<InputAction>(['right']), released: new Set<InputAction>() },
    { x: 1, y: 0, held: new Set<InputAction>(['right']), pressed: new Set<InputAction>(), repeat: new Set<InputAction>(['right']), released: new Set<InputAction>() },
    { x: 0, y: 0, held: new Set<InputAction>(), pressed: new Set<InputAction>(['confirm']), repeat: new Set<InputAction>(['confirm']), released: new Set<InputAction>(['right']) },
  ]
  const seen = states.map((s) => { f.set(s); const r = reads(tap); tap.endFrame(); return r })
  const rec = tap.stop()
  assert.equal(rec.length, 3)

  f.set({ x: 9, y: 9, held: new Set(['bike']), pressed: new Set(), repeat: new Set(), released: new Set() }) // the real input now says something else
  let finished = -1
  const p = tap.play(rec).then((n) => { finished = n; return n })
  assert.equal(tap.playing, true)
  assert.equal(tap.currentDt(), 0.02)
  const played = rec.map(() => { const r = reads(tap); tap.consume('confirm'); tap.endFrame(); return r })
  assert.deepEqual(played, seen, 'every frame reads what was recorded')
  assert.equal(await p, 3)
  assert.equal(finished, 3)
  assert.equal(tap.playing, false)
  assert.deepEqual(f.consumed, [], 'consumption stays inside the replay')
  assert.deepEqual(tap.axis(), { x: 9, y: 9 }, 'afterwards the real input is read again')
  assert.equal(tap.currentDt(), null)
  await assert.rejects(Promise.all([tap.play(rec), tap.play(rec)]), /already playing/)
  tap.cancel()
})

test('scripted frames wait while the game does not tick, and cancel gives up cleanly', async () => {
  const f = fakeInput()
  const tap = createInputTap(f.input, () => 0)
  const p = tap.play(pressFrames('confirm', 0.01))
  tap.setArmed(false)
  tap.endFrame(); tap.endFrame()
  assert.equal(tap.pressed('confirm'), true, 'still on the first frame')
  tap.setArmed(true)
  tap.endFrame()
  assert.equal(tap.pressed('confirm'), false)
  assert.equal(tap.released('confirm'), true)
  tap.endFrame()
  assert.equal(await p, 2)

  const q = tap.play(holdFrames('run', 100, 0.01))
  tap.endFrame(); tap.endFrame()
  assert.equal(tap.cancel(), 2)
  assert.equal(await q, 2)
  assert.equal(tap.playing, false)
})

test('builders: press, hold and axis frames have the shape the game expects', () => {
  const dt = 1 / 60
  const hold = holdFrames('right', 3, dt)
  assert.equal(hold.length, 4)
  const bit = (a: InputAction) => 1 << ACTIONS.indexOf(a)
  assert.deepEqual(hold[0], [dt, 0, 0, bit('right'), bit('right'), bit('right'), 0], 'down, pressed and key-repeat on the first frame')
  assert.deepEqual(hold[1], [dt, 0, 0, bit('right'), 0, 0, 0])
  assert.deepEqual(hold[3], [dt, 0, 0, 0, 0, 0, bit('right')], 'released afterwards')
  const press = pressFrames('confirm', dt)
  assert.deepEqual(press.map((x: Frame) => x[4] !== 0), [true, false])
  const axis = axisFrames(0.5, -1, 4, dt)
  assert.equal(axis.length, 4)
  assert.deepEqual(axis[2], [dt, 0.5, -1, 0, 0, 0, 0])
})
