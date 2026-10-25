/** Public, secret-free configuration for one SSH-backed DSH Workspace. */
export interface SshWorkspaceProfile {
  readonly id: string
  readonly name: string
  readonly host: string
  readonly port: number
  readonly username: string
  readonly remotePath: string
  readonly cachePath: string
  /**
   * `direct` keeps only a tiny local workspace marker and reads/writes files
   * over SSH on demand. `mirror` is the legacy full two-way local mirror.
   */
  readonly workspaceMode?: SshWorkspaceMode
  readonly hostFingerprint: string
  readonly authMode: SshAuthMode
  /** Connection implementation. `auto` preserves the built-in path unless an OpenSSH host alias is configured. */
  readonly transportMode: SshTransportMode
  readonly openSshHost?: string
  readonly helperMode: SshHelperMode
  readonly terminalGraceSeconds: number
  readonly portForwards: readonly SshPortForwardSpec[]
  readonly pollIntervalMs: number
  readonly excludes: readonly string[]
  readonly workspaceId?: string
  readonly createdAt: string
  readonly updatedAt: string
}

export type SshAuthMode = 'password' | 'private-key' | 'agent' | 'openssh-config'

export type SshTransportMode = 'auto' | 'builtin' | 'system'
export type SshHelperMode = 'auto' | 'disabled'
export type SshWorkspaceMode = 'direct' | 'mirror'
export type SshAvailability = 'live' | 'unverifiable' | 'exited'

export interface SshRuntimeCapabilities {
  readonly transport: 'builtin' | 'system'
  readonly sftp: boolean
  readonly helper: boolean
  readonly helperVersion?: number
  readonly remotePlatform?: string
  readonly realtimeFileEvents: boolean
  readonly persistentTerminals: boolean
  readonly portDiscovery: boolean
  readonly portForwarding: boolean
  readonly proxyJump: boolean
  readonly keyboardInteractive: boolean
  readonly degradedReason?: string
}

export interface SshPortForward {
  readonly id: string
  readonly profileId: string
  readonly remoteHost: string
  readonly remotePort: number
  readonly localHost: string
  readonly localPort: number
  readonly createdAt: string
  readonly state: 'starting' | 'ready' | 'error' | 'stopped'
  readonly lastError?: string
}

export interface SshPortForwardSpec {
  readonly remoteHost: string
  readonly remotePort: number
  readonly localHost: string
  readonly localPort: number
}

export interface SshDetectedPort {
  readonly host: string
  readonly port: number
  readonly process?: string
}

export interface OpenSshHostEntry {
  readonly alias: string
  readonly host: string
  readonly port: number
  readonly username?: string
  readonly identityFiles: readonly string[]
  readonly proxyJump?: string
  readonly source?: string
}

/** Secret payload stored only through the DSH credential-record service. */
export interface SshCredentialPayload {
  readonly version: 1
  readonly password?: string
  readonly privateKey?: string
  readonly passphrase?: string
}

export interface SshProfileInput {
  readonly id?: string
  readonly name: string
  readonly host: string
  readonly port?: number
  readonly username: string
  readonly remotePath: string
  readonly workspaceMode?: SshWorkspaceMode
  readonly hostFingerprint?: string
  readonly authMode: SshAuthMode
  readonly transportMode?: SshTransportMode
  readonly openSshHost?: string
  readonly helperMode?: SshHelperMode
  readonly terminalGraceSeconds?: number
  readonly password?: string
  readonly privateKey?: string
  readonly passphrase?: string
  readonly pollIntervalMs?: number
  readonly excludes?: readonly string[]
}

export type SyncPhase = 'idle' | 'connecting' | 'syncing' | 'ready' | 'error' | 'conflict'

export interface SshWorkspaceStatus {
  readonly profileId: string
  readonly phase: SyncPhase
  readonly lastSyncAt?: string
  readonly lastError?: string
  readonly nextRetryAt?: string
  readonly conflictCount: number
  readonly filesPulled: number
  readonly filesPushed: number
  readonly connected: boolean
  readonly availability: SshAvailability
  readonly capabilities?: SshRuntimeCapabilities
  readonly conflicts: readonly SshConflictSummary[]
  readonly deletionGuard?: SshDeletionGuardSummary
}

export interface SshDeletionGuardSummary {
  readonly candidateCount: number
  readonly trackedCount: number
}

export interface SshConflictSummary {
  readonly path: string
  readonly remoteDeleted: boolean
  readonly copyPath?: string
  readonly detectedAt: string
}

export interface SafeSshProfile extends SshWorkspaceProfile {
  readonly credentialConfigured: boolean
  readonly status: SshWorkspaceStatus
}

export interface SshProbeResult {
  readonly ok: true
  readonly fingerprint: string
  readonly remotePath: string
  readonly remoteRealPath: string
  readonly serverBanner?: string
  readonly capabilities: SshRuntimeCapabilities
}

export interface SshWorkspaceApiResult {
  readonly ok: boolean
  readonly code?: string
  readonly message?: string
  readonly profile?: SafeSshProfile
  readonly profiles?: readonly SafeSshProfile[]
  readonly probe?: SshProbeResult
  readonly sync?: SshWorkspaceStatus
  readonly openSshHosts?: readonly OpenSshHostEntry[]
  readonly forwards?: readonly SshPortForward[]
  readonly detectedPorts?: readonly SshDetectedPort[]
  readonly clearedFiles?: number
}

export interface SshRemoteFileRevision {
  readonly token: string
  readonly stamp: string
  readonly size: number
  readonly mtimeMs: number
  readonly strong: boolean
}

export interface SshRemoteFileEntry {
  readonly name: string
  /** Local virtual path under the tiny DSH workspace marker directory. */
  readonly path: string
  readonly isDir: boolean
  readonly hidden: boolean
  readonly isSymlink: boolean
  readonly broken: boolean
}

export interface SshRemoteFileStat {
  readonly exists: boolean
  readonly file: boolean
  readonly directory?: boolean
  readonly revision?: SshRemoteFileRevision
}

export interface SshRemoteFileRead {
  readonly bytes: Uint8Array
  readonly revision: SshRemoteFileRevision
  readonly truncated: boolean
}

/** A bounded slice of a remote file. Unlike `SshRemoteFileRead`, this never
 * hashes or mirrors the complete file and is therefore suitable for media
 * seeking in direct SSH workspaces. */
export interface SshRemoteFileRange {
  readonly bytes: Uint8Array
  readonly revision: SshRemoteFileRevision
}

export const DEFAULT_EXCLUDES = ['.git', 'node_modules', '.dsh-conflicts'] as const
export const DEFAULT_POLL_INTERVAL_MS = 5_000
export const MIN_POLL_INTERVAL_MS = 2_000
export const MAX_POLL_INTERVAL_MS = 60_000
export const DEFAULT_TERMINAL_GRACE_SECONDS = 300
export const MIN_TERMINAL_GRACE_SECONDS = 30
export const MAX_TERMINAL_GRACE_SECONDS = 86_400
