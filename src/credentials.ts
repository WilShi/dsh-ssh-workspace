import { credentialKey, type CredentialProvider, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { SshAuthMode, SshCredentialPayload } from './types.ts'

export const SSH_WORKSPACE_CREDENTIAL_SCOPE = 'dsh-ssh-workspace'

function payloadOf(record: CredentialRecord | undefined): SshCredentialPayload | undefined {
  if (record?.kind !== 'grant' || record.payload === null || typeof record.payload !== 'object' || Array.isArray(record.payload)) {
    return undefined
  }
  const value = record.payload as Record<string, unknown>
  if (value.version !== 1) return undefined
  const password = typeof value.password === 'string' && value.password.length > 0 ? value.password : undefined
  const privateKey = typeof value.privateKey === 'string' && value.privateKey.length > 0 ? value.privateKey : undefined
  const passphrase = typeof value.passphrase === 'string' && value.passphrase.length > 0 ? value.passphrase : undefined
  return {
    version: 1,
    ...(password === undefined ? {} : { password }),
    ...(privateKey === undefined ? {} : { privateKey }),
    ...(passphrase === undefined ? {} : { passphrase }),
  }
}

export class SshCredentialStore {
  constructor(private readonly credentials: CredentialProvider) {}

  async read(profileId: string): Promise<SshCredentialPayload | undefined> {
    return payloadOf(await this.credentials.readRecord(credentialKey(SSH_WORKSPACE_CREDENTIAL_SCOPE, profileId)))
  }

  async configured(profileId: string, authMode: SshAuthMode, systemTransport = false): Promise<boolean> {
    if (authMode === 'openssh-config') return true
    if (authMode === 'agent') return systemTransport || process.env.SSH_AUTH_SOCK !== undefined
    const payload = await this.read(profileId)
    return authMode === 'password' ? payload?.password !== undefined : payload?.privateKey !== undefined
  }

  async write(profileId: string, payload: SshCredentialPayload): Promise<void> {
    await this.credentials.modifyRecord(
      credentialKey(SSH_WORKSPACE_CREDENTIAL_SCOPE, profileId),
      async () => ({ kind: 'grant', payload }),
    )
  }

  async delete(profileId: string): Promise<void> {
    await this.credentials.deleteRecord(credentialKey(SSH_WORKSPACE_CREDENTIAL_SCOPE, profileId))
  }
}
