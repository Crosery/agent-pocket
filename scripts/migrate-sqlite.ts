// One-time JSON (profiles.json) -> SQLite (ap.db) migration & rollback CLI (ADR 0003 §6):
//   node scripts/migrate-sqlite.ts [--data-dir <dir>]
//   node scripts/migrate-sqlite.ts --data-dir <dir> --rollback [--restore-db] [--backup <db-file>]
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { NET } from '../src/server/config.ts'
import {
  migrateJsonToSqlite,
  rollbackSqliteToJson,
  type MigrationReport,
  type RollbackReport,
} from '../src/server/store.ts'

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url))

export interface MigrateCliOptions {
  dataDir: string
  rollback: boolean
  restoreDb: boolean
  backupFile?: string
}

export function parseMigrateArgs(argv: readonly string[]): MigrateCliOptions {
  let dataDir = process.env.AP_DATA_DIR
    ? resolve(process.env.AP_DATA_DIR)
    : resolve(PROJECT_ROOT, NET.store.defaultDir)
  let rollback = false
  let restoreDb = false
  let backupFile: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--data-dir' || arg === '-d') {
      const value = argv[++i]
      if (!value || value.startsWith('-')) throw new Error(`${arg} requires a directory`)
      dataDir = resolve(value)
    } else if (arg === '--rollback') {
      rollback = true
    } else if (arg === '--restore-db') {
      restoreDb = true
    } else if (arg === '--backup') {
      const value = argv[++i]
      if (!value || value.startsWith('-')) throw new Error('--backup requires a file')
      backupFile = resolve(value)
    } else {
      throw new Error(`unknown migration option: ${arg}`)
    }
  }
  if ((restoreDb || backupFile) && !rollback) throw new Error('--restore-db and --backup require --rollback')
  return { dataDir, rollback, restoreDb, ...(backupFile ? { backupFile } : {}) }
}

export async function runMigrateCli(
  argv: readonly string[],
  log: (msg: string) => void = () => {},
): Promise<MigrationReport | RollbackReport> {
  const opts = parseMigrateArgs(argv)
  if (opts.rollback) {
    return rollbackSqliteToJson(opts.dataDir, {
      backupFile: opts.backupFile,
      restoreDbBackup: opts.restoreDb,
      log,
    })
  }
  return migrateJsonToSqlite(opts.dataDir, log)
}

const isMain = !!process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (isMain) {
  runMigrateCli(process.argv.slice(2), (msg) => console.error(`[migrate-sqlite] ${msg}`)).then(
    (report) => {
      console.log(JSON.stringify(report))
    },
    (err: Error) => {
      console.error(`[migrate-sqlite] failed: ${err.message}`)
      process.exit(1)
    },
  )
}
