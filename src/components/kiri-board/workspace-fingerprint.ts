import type { WorkspaceSnapshot } from '~/lib/contracts'

export function workspaceFingerprint(snapshot: WorkspaceSnapshot): string {
  return JSON.stringify(snapshot)
}

export type WorkspaceDedupe = {
  readonly apply: (
    next: WorkspaceSnapshot,
    onChange: (snapshot: WorkspaceSnapshot) => void,
  ) => boolean
  readonly didChange: () => boolean
}

export function createWorkspaceDedupe(initial: WorkspaceSnapshot): WorkspaceDedupe {
  let lastFingerprint = workspaceFingerprint(initial)
  let lastChanged = false
  return {
    apply(next, onChange) {
      const fingerprint = workspaceFingerprint(next)
      if (fingerprint === lastFingerprint) {
        lastChanged = false
        return false
      }
      lastFingerprint = fingerprint
      lastChanged = true
      onChange(next)
      return true
    },
    didChange() {
      return lastChanged
    },
  }
}
