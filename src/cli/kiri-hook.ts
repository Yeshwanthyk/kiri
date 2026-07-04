#!/usr/bin/env tsx

import { readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  backendControlTimeoutMs,
  tryRunBackendOperation,
  type KiriOperationResponseLike,
} from '@kiri/control/backend-control-client'
import { isKiriOperation, type KiriOperation } from '@kiri/control/operation-names'
import { handleCodexSessionStartHook } from '~/server/codex-hook-handler'
import {
  claudeHookEvents,
  handleClaudeHook,
  type ClaudeHookEvent,
} from '~/server/claude-hook-handler'

if (isMainModule()) {
  runHook(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

export async function runHook(args: readonly string[]) {
  const parsed = parseArgs(args)
  if (!parsed.ok) {
    console.error(parsed.reason)
    process.exitCode = 1
    return
  }

  const watchdog = setTimeout(() => process.exit(0), hookWatchdogTimeoutMs())
  watchdog.unref?.()
  try {
    if (parsed.command === 'codex-session-start') {
      const stdin = readHookStdin(parsed.stdinFile)
      const result = handleCodexSessionStartHook({ stdin, env: process.env })
      if (!result.ok) {
        console.error(`codex SessionStart hook failed: ${result.reason ?? 'unknown error'}`)
      } else if (result.reason) {
        console.error(`codex SessionStart hook: ${result.reason}`)
      }
      if (parsed.stdinFile && result.ok) unlinkHookStdinFile(parsed.stdinFile)
      return
    }

    const stdin = readHookStdin(parsed.stdinFile)
    const result = await handleClaudeHook({
      event: parsed.event,
      stdin,
      env: process.env,
      runOperation: runBackendOnlyOperation,
    })
    if (!result.ok) {
      console.error(`claude ${parsed.event} hook failed: ${result.reason ?? 'unknown error'}`)
    } else if (result.reason) {
      console.error(`claude ${parsed.event} hook: ${result.reason}`)
    }
    if (parsed.stdinFile && result.ok) unlinkHookStdinFile(parsed.stdinFile)
    if (parsed.stdinFile && !result.ok) {
      console.error(`claude ${parsed.event} hook stdin retained at ${parsed.stdinFile}`)
    }
  } finally {
    clearTimeout(watchdog)
  }
}

function parseArgs(args: readonly string[]):
  | { readonly ok: true; readonly command: 'codex-session-start'; readonly stdinFile?: string }
  | { readonly ok: true; readonly command: 'claude-hook'; readonly event: ClaudeHookEvent; readonly stdinFile?: string }
  | { readonly ok: false; readonly reason: string } {
  const stdinFile = stdinFileArg(args)
  const positional = args.filter((arg, index) => arg !== '--stdin-file' && args[index - 1] !== '--stdin-file')
  if (positional[0] === 'codex-hook' && positional[1] === 'session-start' && positional.length === 2) {
    return { ok: true, command: 'codex-session-start', ...(stdinFile ? { stdinFile } : {}) }
  }
  if (positional[0] === 'claude-hook' && isClaudeHookEvent(positional[1]) && positional.length === 2) {
    return { ok: true, command: 'claude-hook', event: positional[1], ...(stdinFile ? { stdinFile } : {}) }
  }
  return { ok: false, reason: 'usage: kiri-hook codex-hook session-start|claude-hook <event> [--stdin-file path]' }
}

function stdinFileArg(args: readonly string[]) {
  const index = args.indexOf('--stdin-file')
  if (index === -1) return undefined
  return args[index + 1]?.trim() || undefined
}

function isClaudeHookEvent(value: unknown): value is ClaudeHookEvent {
  return typeof value === 'string' && (claudeHookEvents as readonly string[]).includes(value)
}

function readHookStdin(file: string | undefined) {
  return file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8')
}

function unlinkHookStdinFile(file: string) {
  rmSync(file, { force: true })
}

async function runBackendOnlyOperation(request: {
  readonly operation: string
  readonly params: Record<string, unknown>
}): Promise<KiriOperationResponseLike> {
  const backend = await tryRunBackendOperation(request)
  if (backend.kind === 'handled') return backend.response
  return {
    ok: false,
    operation: operationName(request),
    error: {
      code: 'BACKEND_CONTROL_UNAVAILABLE',
      message: 'Kiri backend control endpoint is unavailable; hook event dropped without local write fallback',
    },
  }
}

function operationName(request: { readonly operation: string }): KiriOperation {
  return isKiriOperation(request.operation) ? request.operation : 'operations.list'
}

function hookWatchdogTimeoutMs() {
  return backendControlTimeoutMs({ operation: 'agent.status.set' }) + 2_000
}

function isMainModule() {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === pathToFileURL(resolve(entry)).href
}
