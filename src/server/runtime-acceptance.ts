export const defaultRuntimeTurnAcceptanceWindowMs = 500

// Runtime turns may run for minutes. Control-plane calls only need to know that
// the turn was accepted, while still surfacing immediate validation failures.
export function detachAfterAcceptance(
  turn: Promise<unknown>,
  windowMs = defaultRuntimeTurnAcceptanceWindowMs,
) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      turn.catch(() => {})
      resolve()
    }, windowMs)
    turn.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
