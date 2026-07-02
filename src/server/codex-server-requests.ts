export function automaticCodexServerRequestResponse(method: string) {
  if (method === 'item/commandExecution/requestApproval') {
    return { decision: 'decline' }
  }
  if (method === 'item/fileChange/requestApproval') {
    return { decision: 'decline' }
  }
  if (method === 'item/permissions/requestApproval') {
    return { permissions: {}, scope: 'turn' }
  }
  if (method === 'mcpServer/elicitation/request') {
    return { action: 'decline', content: null, _meta: null }
  }
  if (method === 'item/tool/call') {
    return {
      contentItems: [{ type: 'inputText', text: 'kiri cannot run client dynamic tools yet.' }],
      success: false,
    }
  }
  if (method === 'execCommandApproval') {
    return { decision: 'denied' }
  }
  if (method === 'applyPatchApproval') {
    return { decision: 'denied' }
  }
  return null
}
