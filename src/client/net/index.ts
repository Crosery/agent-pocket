// Public surface of the client networking module.
export { createNetClient } from './client.ts'
export type { NetClientExt, NetClientOptions, RemotePlayer } from './client.ts'
export { NET_CLIENT } from './config.ts'
export type { NetClientTuning } from './config.ts'
export {
  addServer, deleteServer, getOfficialServer, loadServers, normalizeWsUrl, probeServer,
  resolveServerUrls, saveServers, updateServer, OFFICIAL_SERVER_ID, SERVERS_STORAGE_KEY,
} from './servers.ts'
export type { ResolvedServerUrls, ServerEntry, ServerProbeResult, StorageLike } from './servers.ts'
export {
  bindAccountSave, getAccountSession, getAuthLimits, loginAccount, logoutAccount,
  registerAccount, validatePassword, validateUsername,
} from './auth.ts'
export type { AccountInfo, AccountSessionResult, AuthCredentials } from './auth.ts'
