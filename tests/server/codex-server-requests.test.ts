import { describe, expect, it } from 'vitest'
import { codexReviewDisplayText } from '~/server/codex-review'
import { automaticCodexServerRequestResponse } from '~/server/codex-server-requests'

describe('codex review display text', () => {
  it('keeps review prompts stable', () => {
    expect(codexReviewDisplayText({ type: 'uncommittedChanges' })).toBe('/review')
    expect(codexReviewDisplayText({ type: 'baseBranch', branch: 'main' }))
      .toBe('/review base main')
  })
})

describe('automatic Codex server request responses', () => {
  it('declines approval and elicitation requests without changing payload shape', () => {
    expect(automaticCodexServerRequestResponse('item/commandExecution/requestApproval'))
      .toEqual({ decision: 'decline' })
    expect(automaticCodexServerRequestResponse('item/fileChange/requestApproval'))
      .toEqual({ decision: 'decline' })
    expect(automaticCodexServerRequestResponse('item/permissions/requestApproval'))
      .toEqual({ permissions: {}, scope: 'turn' })
    expect(automaticCodexServerRequestResponse('mcpServer/elicitation/request'))
      .toEqual({ action: 'decline', content: null, _meta: null })
    expect(automaticCodexServerRequestResponse('execCommandApproval'))
      .toEqual({ decision: 'denied' })
    expect(automaticCodexServerRequestResponse('applyPatchApproval'))
      .toEqual({ decision: 'denied' })
  })

  it('answers unsupported tool requests with the existing failure message', () => {
    expect(automaticCodexServerRequestResponse('item/tool/requestUserInput'))
      .toEqual({ answers: {} })
    expect(automaticCodexServerRequestResponse('item/tool/call')).toEqual({
      contentItems: [{ type: 'inputText', text: 'kiri cannot run client dynamic tools yet.' }],
      success: false,
    })
  })

  it('leaves unknown requests to the caller', () => {
    expect(automaticCodexServerRequestResponse('unknown/request')).toBeNull()
  })
})
