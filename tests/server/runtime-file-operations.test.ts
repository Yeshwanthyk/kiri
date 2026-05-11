import { describe, expect, it } from 'vitest'
import {
  fileOperationFromCodexItem,
  fileOperationFromPiEvent,
  fileOperationFromTool,
  fileOperationStatusFromEvent,
  isFileOperationCompletionEvent,
} from '../../src/server/runtime-file-operations'

describe('runtime file operation detection', () => {
  it('detects Claude edit tools with file paths', () => {
    expect(fileOperationFromTool('Edit', {
      file_path: 'src/app.ts',
      old_string: 'a',
      new_string: 'b',
    })).toMatchObject({
      toolName: 'Edit',
      path: 'src/app.ts',
      summary: 'Edit: src/app.ts',
    })
  })

  it('ignores read-only tools', () => {
    expect(fileOperationFromTool('Read', { file_path: 'src/app.ts' })).toBeNull()
  })

  it('detects write and multi-edit tools', () => {
    expect(fileOperationFromTool('Write', { path: 'notes.md' })).toMatchObject({
      toolName: 'Write',
      path: 'notes.md',
    })
    expect(fileOperationFromTool('MultiEdit', { file_path: 'src/app.ts' })).toMatchObject({
      toolName: 'MultiEdit',
      path: 'src/app.ts',
    })
  })

  it('detects apply_patch commands and extracts the touched file', () => {
    expect(fileOperationFromTool('Bash', {
      command: 'apply_patch <<PATCH\n*** Begin Patch\n*** Update File: src/app.ts\n@@\nPATCH',
    })).toMatchObject({
      toolName: 'apply_patch',
      path: 'src/app.ts',
    })
  })

  it('detects Codex file change and command execution items', () => {
    expect(fileOperationFromCodexItem({
      type: 'fileChange',
      path: 'src/app.ts',
    })).toMatchObject({
      toolName: 'fileChange',
      path: 'src/app.ts',
    })
    expect(fileOperationFromCodexItem({
      type: 'commandExecution',
      command: '*** Begin Patch\n*** Add File: src/new.ts',
    })).toMatchObject({
      toolName: 'apply_patch',
      path: 'src/new.ts',
    })
  })

  it('detects Pi tool events and completion status', () => {
    const event = {
      type: 'tool_completed',
      toolName: 'write',
      args: { path: 'src/pi.ts' },
    }
    expect(fileOperationFromPiEvent(event)).toMatchObject({
      toolName: 'write',
      path: 'src/pi.ts',
    })
    expect(isFileOperationCompletionEvent(event)).toBe(true)
    expect(fileOperationStatusFromEvent(event)).toBe('completed')
    expect(fileOperationStatusFromEvent({ ...event, type: 'tool_failed' })).toBe('failed')
  })
})
