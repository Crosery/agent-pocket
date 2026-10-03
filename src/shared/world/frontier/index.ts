// Public API of the infinite frontier (see docs/world.md "Infinite frontier").
export { FrontierProvider, type FrontierInit } from './provider.ts'
export {
  registerChunkDecorator, registerInteriorDecorator, unregisterDecorator, formatScript,
  type ChunkDecorContext, type ChunkDecorator, type DecorSite, type FrontierLookup, type InteriorDecorContext, type InteriorDecorator,
} from './decorate.ts'
export { CHUNK_BIOME } from './chunk.ts'
export { parseFrontierId, siteId, type FrontierSite, type Gate } from './sites.ts'
export { parseRegionId, regionId } from './regions.ts'
export { FRONTIER_CONTENT } from './config.ts'
// Frontier NPCs / trainers / bounties / landmark roles (registers its decorators on import) + id resolvers.
export {
  frontierTrainer, frontierQuest, registerFrontierRefs, restoreFrontierQuests, frontierPlaceRefs, frontierProvider,
  FRONTIER_PACK, validateFrontierPack,
} from './content/index.ts'
