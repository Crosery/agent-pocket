// Client view of content/net.json (transport tunables shared with the server).
import netJson from '../../../content/net.json' with { type: 'json' }

export type CloseCodeKey = 'shutdown' | 'duplicate' | 'version' | 'flood' | 'helloTimeout' | 'serverFull' | 'slowConsumer' | 'devNotAllowed'

export interface NetClientTuning {
  protocol: { wsPath: string; closeCodes: Record<CloseCodeKey, number> }
  auth?: {
    usernameMinLen: number
    usernameMaxLen: number
    passwordMinLen: number
    passwordMaxLen: number
  }
  client: {
    reconnect: { baseMs: number; maxMs: number; factor: number; jitter: number }
    pingSeconds: number
    pingTimeoutSeconds: number
    /** EMA weight of a new RTT sample. */
    rttSmoothing: number
    interpolationDelayMs: number
    interpolationMinMs: number
    interpolationMaxMs: number
    maxExtrapolateMs: number
    correctionMs: number
    predictionMaxPending: number
    predictionReplayStepMaxTiles: number
    stallThresholdMs: number
    metricsWindowSize: number
    sampleBufferMs: number
    snapDistanceTiles: number
    positionDecimals: number
    profileDebounceMs: number
    leaderboardTimeoutMs: number
  }
  http: { leaderboardPath: string; metricsPath: string }
}

export const NET_CLIENT: NetClientTuning = netJson as unknown as NetClientTuning
