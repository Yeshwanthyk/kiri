import { Plus } from 'lucide-react'
import { describe, expect, it, vi } from 'vitest'
import type { CommandPaletteAction } from '~/components/kiri-board/board-types'
import { runHostMenuAction } from '~/components/kiri-board/host-menu-actions'

describe('runHostMenuAction', () => {
  it('runs an enabled command action by id', () => {
    const run = vi.fn()

    expect(runHostMenuAction([action({ id: 'settings', run })], 'settings')).toBe(true)
    expect(run).toHaveBeenCalledOnce()
  })

  it('ignores disabled and missing command actions', () => {
    const disabledRun = vi.fn()
    const enabledRun = vi.fn()
    const actions = [
      action({ id: 'disabled', disabled: true, run: disabledRun }),
      action({ id: 'enabled', run: enabledRun }),
    ]

    expect(runHostMenuAction(actions, 'disabled')).toBe(false)
    expect(runHostMenuAction(actions, 'missing')).toBe(false)
    expect(disabledRun).not.toHaveBeenCalled()
    expect(enabledRun).not.toHaveBeenCalled()
  })
})

function action(input: {
  id: string
  disabled?: boolean
  run: () => void
}): CommandPaletteAction {
  return {
    id: input.id,
    title: input.id,
    detail: input.id,
    icon: Plus,
    disabled: input.disabled ?? false,
    run: input.run,
  }
}
