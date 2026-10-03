// Loader for content/world/frontier-content/*.json (the only place frontier NPC / trainer / bounty data enters the
// code). The story bounty file is read (never written) so frontier bounties reuse its kinds, texts and rewards.
import type { BountiesFile, BountyReward, InteriorsFile, LandmarksFile, PackCommon, StoryBountiesFile, TrainersFile, VillagersFile, WildFile } from './schema.ts'

import commonJson from '../../../../../content/world/frontier-content/common.json' with { type: 'json' }
import villagersJson from '../../../../../content/world/frontier-content/villagers.json' with { type: 'json' }
import trainersJson from '../../../../../content/world/frontier-content/trainers.json' with { type: 'json' }
import bountiesJson from '../../../../../content/world/frontier-content/bounties.json' with { type: 'json' }
import landmarksJson from '../../../../../content/world/frontier-content/landmarks.json' with { type: 'json' }
import wildJson from '../../../../../content/world/frontier-content/wild.json' with { type: 'json' }
import interiorsJson from '../../../../../content/world/frontier-content/interiors.json' with { type: 'json' }
import storyBountiesJson from '../../../../../content/world/story/bounties.json' with { type: 'json' }
import storyJson from '../../../../../content/world/story/story.json' with { type: 'json' }

export interface FrontierPack {
  common: PackCommon
  villagers: VillagersFile
  trainers: TrainersFile
  bounties: BountiesFile
  landmarks: LandmarksFile
  wild: WildFile
  interiors: InteriorsFile
  /** content/world/story/bounties.json (format + texts reused by frontier bounties). */
  story: StoryBountiesFile
}

export const FRONTIER_PACK: FrontierPack = {
  common: commonJson as unknown as PackCommon,
  villagers: villagersJson as unknown as VillagersFile,
  trainers: trainersJson as unknown as TrainersFile,
  bounties: bountiesJson as unknown as BountiesFile,
  landmarks: landmarksJson as unknown as LandmarksFile,
  wild: wildJson as unknown as WildFile,
  interiors: interiorsJson as unknown as InteriorsFile,
  story: storyBountiesJson as unknown as StoryBountiesFile,
}

/** Story conventions shared with the client (trainer-won flag prefix). Read-only view of content/world/story/story.json. */
export const STORY_META = storyJson as unknown as { flags: { trainerWon: string } }

/** Reward table: bounties.json override, else the story bounty table. */
export function bountyReward(p: FrontierPack = FRONTIER_PACK): BountyReward | null {
  return p.bounties.reward ?? p.story.reward ?? null
}
