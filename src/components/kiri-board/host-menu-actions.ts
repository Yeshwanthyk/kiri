'use client'

import * as React from 'react'
import type { KiriHostBridge } from '~/lib/host-capabilities'
import { getKiriHostBridge } from '~/lib/host-capabilities'
import type { CommandPaletteAction } from './board-types'

export function useHostMenuActions(
  actions: CommandPaletteAction[],
  getBridge: () => KiriHostBridge | undefined = getKiriHostBridge,
) {
  React.useEffect(() => {
    const unsubscribe = getBridge()?.onMenuAction?.((actionId) => {
      runHostMenuAction(actions, actionId)
    })
    return unsubscribe
  }, [actions, getBridge])
}

export function runHostMenuAction(actions: CommandPaletteAction[], actionId: string) {
  const action = actions.find((item) => item.id === actionId)
  if (!action || action.disabled) return false
  action.run()
  return true
}
