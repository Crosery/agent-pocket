// Public surface of the renderer module.
export { createRenderer, isHD2DRendererExt, type HD2DRendererExt, type InternalSize } from './hd2d.ts'
export { createWorldView, type WorldViewExt } from './world-view.ts'
export type { StreamStats } from './world/streamer.ts'
export * from './sprite-utils.ts'
export { RENDER, qualityPreset, sampleLighting, sunState, validateRenderContent, type RenderContent, type QualityPreset, type LightingState } from './config.ts'
export { renderPattern, patternTexture, type PatternSpec } from './world/patterns.ts'
export { walkHeight, footprintRect, footprintCenter, tileOf } from './world/coords.ts'
