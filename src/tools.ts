import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { resolve } from 'node:path'
import type { SshWorkspaceManager } from './manager.ts'

function callerCwd(exec: ToolRunContext): string {
  const cwd = exec.agent?.session.header.cwd
  if (cwd === undefined || cwd === '') throw new Error('当前会话没有工作区')
  return cwd
}

/** Model-facing tools keep command execution on the SSH server while the Agent itself remains local. */
export function createSshWorkspaceTools(manager: SshWorkspaceManager) {
  const run = defineTool({
    name: 'ssh_workspace_run',
    description:
      'Run a shell command on the SSH server backing the current DSH remote workspace. '
      + 'Use this instead of local shell/subprocess tools for builds, tests, Git, process inspection, and server-side commands whenever the current workspace is SSH-backed. '
      + 'The command runs in the remote directory corresponding to the current local cache directory.',
    parameters: {
      command: { type: 'string', required: true, description: 'Shell command to execute on the remote server.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          workspace: { type: 'string', required: true },
          host: { type: 'string', required: true },
          remoteDirectory: { type: 'string', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          exitCode: { type: 'integer', required: true },
          signal: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const result = value as { stdout: string; stderr: string; exitCode: number | null }
        const parts = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean)
        parts.push(`[远程命令退出码：${String(result.exitCode)}]`)
        return [{ type: 'text', text: parts.join('\n') }]
      },
    },
    async execute(args: { command: string }, exec) {
      const result = await manager.executeForCachePath(callerCwd(exec), args.command, exec.signal)
      return {
        workspace: result.profile.name,
        host: result.profile.host,
        remoteDirectory: result.profile.remotePath,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? -1,
        ...(result.signal === undefined ? {} : { signal: result.signal }),
      }
    },
  })

  const sync = defineTool({
    name: 'ssh_workspace_sync',
    description:
      'Refresh the current SSH-backed DSH workspace. In direct mode this never downloads the directory; it only refreshes connection/watch state. '
      + 'In legacy mirror mode it synchronizes the local cache with the server. '
      + 'Use after file edits when the user asks to ensure remote persistence, or before reading files that may have changed on the server. '
      + 'Concurrent local and remote edits are preserved as conflicts and are never silently overwritten.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          profileId: { type: 'string', required: true },
          phase: { type: 'string', required: true },
          conflictCount: { type: 'integer', required: true },
          filesPulled: { type: 'integer', required: true },
          filesPushed: { type: 'integer', required: true },
          lastSyncAt: { type: 'string' },
          lastError: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const status = value as { phase: string; conflictCount: number; filesPulled: number; filesPushed: number; lastError?: string }
        return [{
          type: 'text',
          text: status.phase === 'error'
            ? `远程工作区同步失败：${status.lastError ?? '未知错误'}`
            : `远程工作区同步完成：拉取 ${status.filesPulled} 个，推送 ${status.filesPushed} 个，冲突 ${status.conflictCount} 个。`,
        }]
      },
    },
    async execute(_args: Record<string, never>, exec) {
      const profile = await manager.findByCachePath(callerCwd(exec))
      if (profile === undefined) throw new Error('当前工作区不是 SSH 远程工作区')
      const status = await manager.sync(profile.id)
      return {
        profileId: status.profileId,
        phase: status.phase,
        conflictCount: status.conflictCount,
        filesPulled: status.filesPulled,
        filesPushed: status.filesPushed,
        ...(status.lastSyncAt === undefined ? {} : { lastSyncAt: status.lastSyncAt }),
        ...(status.lastError === undefined ? {} : { lastError: status.lastError }),
      }
    },
  })

  const list = defineTool({
    name: 'ssh_workspace_list',
    description: 'List one directory in the current SSH direct workspace on demand without downloading its contents. Paths are relative to the workspace root.',
    parameters: { path: { type: 'string', description: 'Workspace-relative directory. Defaults to the workspace root.' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      path: { type: 'string', required: true },
      entries: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        name: { type: 'string', required: true }, kind: { type: 'string', required: true },
      } } },
      truncated: { type: 'boolean', required: true },
    } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args: { path?: string }, exec) {
      const cwd = callerCwd(exec)
      const listing = await manager.listRemoteDirectory(cwd, resolve(cwd, args.path ?? '.'), 2_000)
      return {
        path: args.path ?? '.',
        entries: listing.entries.map(entry => ({ name: entry.name, kind: entry.isDir ? 'directory' : entry.isSymlink ? 'symlink' : 'file' })),
        truncated: listing.truncated,
      }
    },
  })

  const read = defineTool({
    name: 'ssh_workspace_read',
    description: 'Read a text file directly from the current SSH workspace. The file is fetched on demand and is not mirrored locally.',
    parameters: {
      path: { type: 'string', required: true, description: 'Workspace-relative file path.' },
      maximumBytes: { type: 'integer', description: 'Read cap; defaults to 4 MiB and cannot exceed 32 MiB.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      path: { type: 'string', required: true }, content: { type: 'string', required: true },
      truncated: { type: 'boolean', required: true }, revision: { type: 'string', required: true },
    } }, render: (_args, value) => [{ type: 'text', text: (value as { content: string }).content }] },
    async execute(args: { path: string; maximumBytes?: number }, exec) {
      const cwd = callerCwd(exec)
      const maximum = Math.min(32 * 1024 * 1024, Math.max(1, Math.floor(args.maximumBytes ?? 4 * 1024 * 1024)))
      const result = await manager.readRemoteFile(cwd, resolve(cwd, args.path), maximum, exec.signal)
      if (result.bytes.includes(0)) throw new Error('目标是二进制文件，请使用侧边栏预览或远程命令处理')
      return { path: args.path, content: Buffer.from(result.bytes).toString('utf8'), truncated: result.truncated, revision: result.revision.token }
    },
  })

  const write = defineTool({
    name: 'ssh_workspace_write',
    description: 'Atomically write a UTF-8 text file directly to the current SSH workspace. No full workspace download is performed.',
    parameters: {
      path: { type: 'string', required: true, description: 'Workspace-relative file path.' },
      content: { type: 'string', required: true, description: 'Complete UTF-8 file content.' },
      expectedRevision: { type: 'string', description: 'Optional revision returned by ssh_workspace_read for conflict protection.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      path: { type: 'string', required: true }, revision: { type: 'string', required: true }, size: { type: 'integer', required: true },
    } }, render: (_args, value) => [{ type: 'text', text: `已写入远程文件 ${(value as { path: string }).path}` }] },
    async execute(args: { path: string; content: string; expectedRevision?: string }, exec) {
      const cwd = callerCwd(exec)
      const bytes = Buffer.from(args.content, 'utf8')
      const revision = await manager.writeRemoteFile(cwd, resolve(cwd, args.path), bytes, args.expectedRevision)
      return { path: args.path, revision: revision.token, size: bytes.byteLength }
    },
  })

  const mkdir = defineTool({
    name: 'ssh_workspace_mkdir',
    description: 'Create a directory directly in the current SSH workspace.',
    parameters: { path: { type: 'string', required: true, description: 'Workspace-relative directory path.' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true }, ok: { type: 'boolean', required: true } } }, render: (_args, value) => [{ type: 'text', text: `已创建远程目录 ${(value as { path: string }).path}` }] },
    async execute(args: { path: string }, exec) {
      const cwd = callerCwd(exec)
      await manager.createRemoteDirectory(cwd, resolve(cwd, args.path))
      return { path: args.path, ok: true }
    },
  })

  const remove = defineTool({
    name: 'ssh_workspace_remove',
    description: 'Remove a file or directory directly from the current SSH workspace. Recursive directory removal must be explicitly requested.',
    parameters: {
      path: { type: 'string', required: true, description: 'Workspace-relative path.' },
      recursive: { type: 'boolean', description: 'Required for non-empty directories.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true }, ok: { type: 'boolean', required: true } } }, render: (_args, value) => [{ type: 'text', text: `已删除远程路径 ${(value as { path: string }).path}` }] },
    async execute(args: { path: string; recursive?: boolean }, exec) {
      const cwd = callerCwd(exec)
      await manager.removeRemotePath(cwd, resolve(cwd, args.path), args.recursive === true)
      return { path: args.path, ok: true }
    },
  })

  return [run, sync, list, read, write, mkdir, remove] as const
}
