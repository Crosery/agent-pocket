import netSimJson from '../../../content/dev/net-sim.json' with { type: 'json' }
import type { NetSimConfig } from './net-sim.ts'

export const NET_SIM: NetSimConfig = netSimJson as unknown as NetSimConfig
