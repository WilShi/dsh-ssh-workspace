import { connectionSpec, openSshConnection, type SshConnection } from './ssh-client.ts'
import type { SshCredentialPayload, SshWorkspaceProfile } from './types.ts'

export interface SshConnectionLease {
  readonly connection: SshConnection
  release(): void
}

interface PoolEntry {
  readonly promise: Promise<SshConnection>
  connection?: SshConnection
  references: number
  idleTimer?: ReturnType<typeof setTimeout>
  invalidated: boolean
}

/** Reuse authenticated ssh2 transports while keeping every channel independently disposable. */
export class SshConnectionPool {
  private readonly entries = new Map<string, PoolEntry>()

  constructor(private readonly idleMs = 60_000) {}

  async acquire(profile: SshWorkspaceProfile, credential?: SshCredentialPayload): Promise<SshConnectionLease> {
    let entry = this.entries.get(profile.id)
    if (entry === undefined || entry.invalidated) {
      const promise = openSshConnection(connectionSpec(profile, credential))
      entry = { promise, references: 0, invalidated: false }
      this.entries.set(profile.id, entry)
      void promise.then(connection => {
        entry!.connection = connection
        const evict = (): void => {
          entry!.invalidated = true
          if (this.entries.get(profile.id) === entry) this.entries.delete(profile.id)
        }
        connection.client.once('close', evict)
        connection.client.once('error', evict)
      }, () => {
        if (this.entries.get(profile.id) === entry) this.entries.delete(profile.id)
      })
    }
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer)
    entry.idleTimer = undefined
    entry.references++
    let connection: SshConnection
    try {
      connection = await entry.promise
    } catch (error) {
      entry.references--
      throw error
    }
    let released = false
    return {
      connection,
      release: () => {
        if (released) return
        released = true
        entry!.references = Math.max(0, entry!.references - 1)
        if (entry!.references !== 0 || entry!.invalidated) return
        entry!.idleTimer = setTimeout(() => this.closeEntry(profile.id, entry!), this.idleMs)
        entry!.idleTimer.unref?.()
      },
    }
  }

  invalidate(profileId: string): void {
    const entry = this.entries.get(profileId)
    if (entry === undefined) return
    entry.invalidated = true
    this.entries.delete(profileId)
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer)
    void entry.promise.then(connection => connection.dispose(), () => {})
  }

  dispose(): void {
    for (const [id, entry] of this.entries) this.closeEntry(id, entry)
    this.entries.clear()
  }

  private closeEntry(id: string, entry: PoolEntry): void {
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer)
    entry.idleTimer = undefined
    entry.invalidated = true
    if (this.entries.get(id) === entry) this.entries.delete(id)
    void entry.promise.then(connection => connection.dispose(), () => {})
  }
}

