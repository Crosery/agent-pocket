// Client view of content/net.json (transport tunables shared with the server).
import netJson from '../../../content/net.json' with { type: 'json' }
export type CloseCodeKey = 'shutdown' | 'duplicate' | 'version' | 'flood' | 'helloTimeout' | 'serverFull' | 'slowConsumer' | 'devNotAllowed'

export interface NetClientTuning {
  protocol: { wsPath: string; closeCodes: Record<CloseCodeKey, number> }
  auth: {
    username: { minLen: number; maxLen: number; pattern: string }
    password: { minLen: number; maxLen: number }
  }
  official: {
    name: string
    url: string
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

export const NET_CLIENT: NetClientTuning = {
  protocol: netJson.protocol as NetClientTuning['protocol'],
  auth: {
    username: netJson.auth.username,
    password: netJson.auth.password,
  },
  official: netJson.official,
  client: netJson.client,
  http: {
    leaderboardPath: netJson.http.leaderboardPath,
    metricsPath: netJson.http.metricsPath,
  },
}
