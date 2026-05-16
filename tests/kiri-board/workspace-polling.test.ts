import { describe, expect, it, vi } from 'vitest'

import { pollWorkspaceDuringAction } from '~/components/kiri-board/workspace-polling'

describe('workspace polling', () => {
  it('does not refresh when an action finishes before the initial poll delay', async () => {
    vi.useFakeTimers()
    try {
      const refreshWorkspace = vi.fn(() => Promise.resolve({ version: 1 }))
      const onWorkspace = vi.fn()
      const result = pollWorkspaceDuringAction({
        action: () => Promise.resolve('done'),
        refreshWorkspace,
        onResult: vi.fn(),
        onWorkspace,
        timers: nodeFakeTimers(),
      })

      await result
      await vi.advanceTimersByTimeAsync(1_000)

      expect(refreshWorkspace).not.toHaveBeenCalled()
      expect(onWorkspace).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds send-time refreshes to the configured polling cadence', async () => {
    vi.useFakeTimers()
    try {
      let finishAction!: () => void
      const action = new Promise<'done'>((resolve) => {
        finishAction = () => resolve('done')
      })
      const refreshWorkspace = vi.fn(() =>
        Promise.resolve({ version: refreshWorkspace.mock.calls.length })
      )
      const onWorkspace = vi.fn()
      const onPoll = vi.fn(() => Promise.resolve())
      const onResult = vi.fn()

      const result = pollWorkspaceDuringAction({
        action: () => action,
        refreshWorkspace,
        onResult,
        onWorkspace,
        onPoll,
        timers: nodeFakeTimers(),
      })

      await vi.advanceTimersByTimeAsync(249)
      expect(refreshWorkspace).toHaveBeenCalledTimes(0)

      await vi.advanceTimersByTimeAsync(1)
      expect(refreshWorkspace).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(750)
      await vi.advanceTimersByTimeAsync(750)
      expect(refreshWorkspace).toHaveBeenCalledTimes(3)
      expect(onPoll).toHaveBeenCalledTimes(3)

      finishAction()
      await result
      await vi.advanceTimersByTimeAsync(2_000)

      expect(onResult).toHaveBeenCalledWith('done')
      expect(onWorkspace).toHaveBeenCalledTimes(3)
      expect(refreshWorkspace).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps send detail refreshes to polling plus one final refresh', async () => {
    vi.useFakeTimers()
    try {
      let finishSend!: () => void
      const send = new Promise<'snapshot-from-send'>((resolve) => {
        finishSend = () => resolve('snapshot-from-send')
      })
      const refreshWorkspace = vi.fn(() => Promise.resolve('snapshot-from-poll'))
      const setWorkspace = vi.fn()
      const refreshDetail = vi.fn(() => Promise.resolve())

      const sendResult = (async () => {
        await pollWorkspaceDuringAction({
          action: () => send,
          refreshWorkspace,
          onResult: setWorkspace,
          onWorkspace: setWorkspace,
          onPoll: refreshDetail,
          timers: nodeFakeTimers(),
        })
        await refreshDetail()
      })()

      await vi.advanceTimersByTimeAsync(250)
      await vi.advanceTimersByTimeAsync(750)
      expect(refreshWorkspace).toHaveBeenCalledTimes(2)
      expect(refreshDetail).toHaveBeenCalledTimes(2)

      finishSend()
      await sendResult
      await vi.advanceTimersByTimeAsync(2_000)

      expect(setWorkspace).toHaveBeenCalledTimes(3)
      expect(setWorkspace).toHaveBeenLastCalledWith('snapshot-from-send')
      expect(refreshWorkspace).toHaveBeenCalledTimes(2)
      expect(refreshDetail).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })
})

function nodeFakeTimers() {
  return {
    setTimeout: (callback: () => void, delayMs: number) =>
      setTimeout(callback, delayMs) as unknown as number,
    clearTimeout: (timer: number) => clearTimeout(timer as unknown as NodeJS.Timeout),
    now: () => Date.now(),
  }
}
