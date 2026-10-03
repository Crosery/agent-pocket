// Runs the game server (node --watch) and the Vite client dev server together.
import { spawn } from 'node:child_process'

const procs = [
  spawn(process.execPath, ['--watch', 'src/server/index.ts'], { stdio: 'inherit', env: { ...process.env, AP_DEV: '1' } }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' }),
]
const stop = () => { for (const p of procs) p.kill('SIGTERM'); process.exit(0) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
for (const p of procs) p.on('exit', (code) => { if (code) stop() })
