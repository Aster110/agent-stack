import type { ITerminal, SpawnResult } from './interface.js'

/** Pull/SSE-only relay. It never opens or injects a terminal. */
export class NoTerminal implements ITerminal {
  async inject(_sessionId: string, _text: string): Promise<boolean> { return false }
  async spawn(_cmd: string): Promise<SpawnResult> { throw new Error('Terminal spawning is disabled in this pull-only relay') }
  async isAlive(_sessionId: string): Promise<boolean> { return false }
  async close(_sessionId: string): Promise<void> { throw new Error('Terminal operations are disabled in this pull-only relay') }
  async getCurrentSession(): Promise<null> { return null }
}
