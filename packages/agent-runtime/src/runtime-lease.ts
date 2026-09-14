import Database from 'better-sqlite3'
import fs from 'node:fs'

/** Local OS-backed SQLite lock. Released even on SIGKILL; no stale PID guessing. */
export class RuntimeLease {
  private db: Database.Database
  constructor(file: string) {
    this.db = new Database(file, {timeout: 0})
    try {
      fs.chmodSync(file, 0o600)
      this.db.exec('BEGIN EXCLUSIVE')
    } catch (error) {
      this.db.close()
      throw new Error('Runtime state is already owned by another process', {cause: error})
    }
  }
  close(): void { this.db.close() }
}
