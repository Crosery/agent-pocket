// Client view of content/net.json (transport tunables shared with the server).
import netJson from '../../../content/net.json' with { type: 'json' }

export type CloseCodeKey = 'shutdown' | 'duplicate' | 'version' | 'flood' | 'helloTimeout' | 'serverFull' | 'slowConsumer'

export interface NetClientTuning {
  protocol: { wsPath: string; closeCodes: Record<CloseCodeKey, number> }
  client: {
    reconnect: { baseMs: number; maxMs: number; factor: number; jitter: number }
    pingSeconds: number
    pingTimeoutSeconds: number
    /** EMA weight of a new RTT sample. */
    rttSmoothing: number
    interpolationDelayMs: number
    sampleBufferMs: number
    snapDistanceTiles: number
    positionDecimals: number
    profileDebounceMs: number
    leaderboardTimeoutMs: number
  }
  http: { leaderboardPath: string }
}

export const NET_CLIENT: NetClientTuning = netJson as unknown as NetClientTuning
