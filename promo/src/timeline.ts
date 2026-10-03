// The edit: data/timeline.json plates (in bars) resolved to seconds through the analysed downbeats.
import type { TimelineEntry } from './engine/engine';
import type { SceneClass } from './engine/scene';
import type { AudioData } from './engine/audio';
import { D } from './engine/data';

const modules = import.meta.glob<{ default: SceneClass }>('./scenes/*.ts');
const scene = (name: string) => () => {
  const m = modules[`./scenes/${name}.ts`];
  return m ? m() : Promise.reject(new Error(`scene module not found: scenes/${name}.ts`));
};

export function makeTimeline(au: AudioData): TimelineEntry[] {
  const at = (b: number | 'end') => (b === 'end' ? au.duration : au.timeOfBar(b));
  // per-plate post (bloom, vignette …) from data/style.json platePost; scenes only add event overrides (flash, shake)
  const pp = (D.style.platePost ?? {}) as Record<string, Record<string, number>>;
  return D.timeline.plates.map((p) => ({ id: p.id, load: scene(p.scene), start: at(p.from), end: at(p.to), plate: p, params: p.params ?? {}, post: pp[p.id] }));
}
