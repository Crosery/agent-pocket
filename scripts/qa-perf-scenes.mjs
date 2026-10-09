// Viewports and scenes shared by the issue #36 benchmarks (qa-perf.mjs, qa-perf-shots.mjs).
export const VIEWPORTS = {
  phone: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, touch: true, throttle: 4 },
  desktop: { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false, touch: false, throttle: 1 },
}
export const SCENES = {
  'town-day': { scenario: 'fresh-start', setup: [['clock.set', { minutes: 720 }], ['clock.freeze', { on: true }], ['weather.set', { kind: 'clear' }]], wait: 'free' },
  'night-rain-forge': { scenario: 'night-rain-forge', setup: [], wait: 'free' },
  'frontier-far': { scenario: 'frontier-far', setup: [['clock.set', { minutes: 720 }], ['clock.freeze', { on: true }]], wait: 'free' },
  'boss-battle': { scenario: 'boss-astra-counter', setup: [], wait: 'battle' },
  'peers-square': { scenario: 'fake-peers-square', setup: [], wait: 'free' },
}
