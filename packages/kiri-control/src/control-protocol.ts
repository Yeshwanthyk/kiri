export const controlProtocolVersion = 1
export const controlProtocolVersionHeader = 'x-kiri-control-version'

export type ControlProtocolWarning = {
  readonly code: 'CONTROL_PROTOCOL_VERSION_MISMATCH'
  readonly message: string
  readonly expectedVersion: number
  readonly receivedVersion: number | null
}

export function parseControlProtocolVersion(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  if (typeof value !== 'string') return null
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

export function controlProtocolWarning(receivedVersion: number | null): ControlProtocolWarning | null {
  if (receivedVersion === controlProtocolVersion) return null
  return {
    code: 'CONTROL_PROTOCOL_VERSION_MISMATCH',
    message: receivedVersion === null
      ? `Kiri control client did not send protocol version ${controlProtocolVersion}`
      : `Kiri control client sent protocol version ${receivedVersion}; backend expects ${controlProtocolVersion}`,
    expectedVersion: controlProtocolVersion,
    receivedVersion,
  }
}
