// Who currently owns the keyboard and the touch controls: the panel, the editor. The game only gets them back
// once nobody holds them.
import type { GameHost } from '../kit.ts'

export interface InputGate { hold(owner: string): void; release(owner: string): void }

export function createInputGate(host: Pick<GameHost, 'overworld' | 'ctx'>): InputGate {
  const owners = new Set<string>()
  const apply = () => {
    const held = owners.size > 0
    host.overworld.setControlEnabled(!held)
    host.ctx.input.setTouchControlsVisible(!held && document.documentElement.dataset.touchControls === 'on')
  }
  return {
    hold(o) { if (!owners.has(o)) { owners.add(o); apply() } },
    release(o) { if (owners.delete(o)) apply() },
  }
}
