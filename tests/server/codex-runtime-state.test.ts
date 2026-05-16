import { describe, expect, it } from 'vitest'
import { parseCodexRuntimeStateJson } from '~/server/codex-runtime'

describe('Codex runtime state parsing', () => {
  it('surfaces corrupt or non-object runtime state json', () => {
    expect(parseCodexRuntimeStateJson(JSON.stringify({ threadId: 'thread-1' })))
      .toEqual({ threadId: 'thread-1' })
    expect(() => parseCodexRuntimeStateJson('{not-json')).toThrow('Invalid runtime state JSON')
    expect(() => parseCodexRuntimeStateJson('[]')).toThrow('Invalid runtime state JSON')
    expect(() => parseCodexRuntimeStateJson('"oops"')).toThrow('Invalid runtime state JSON')
  })
})
