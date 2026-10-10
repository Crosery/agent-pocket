// Public surface of the client networking module.
export { createNetClient } from './client.ts'
export type { NetClientExt, NetClientOptions, RemotePlayer } from './client.ts'
export { NET_CLIENT } from './config.ts'
export type { NetClientTuning } from './config.ts'
export {
  addServer, deleteServer, getOfficialServer, loadServers, normalizeWsUrl, probeServer,
  resolveServerUrls, sanitizeServerAddress, saveServers, updateServer, OFFICIAL_SERVER_ID, SERVERS_STORAGE_KEY,
} from './servers.ts'
export type { ResolvedServerUrls, SanitizedServerAddress, SanitizeServerError, ServerEntry, ServerProbeResult, StorageLike } from './servers.ts'
export {
  bindAccountSave, getAccountSession, getAuthLimits, loginAccount, logoutAccount,
  registerAccount, validatePassword, validateUsername,
} from './auth.ts'
export type { AccountInfo, AccountSessionResult, AuthCredentials } from './auth.ts'
export { adaptiveInterpDelay, pushSample, sampleAt } from './interp.ts'
export type { InterpOptions, Sample } from './interp.ts'
export { createPredictor } from './predict.ts'
export type { CorrectionState, PredictedMove, Predictor, PredictorOptions, StepReplayFn } from './predict.ts'
