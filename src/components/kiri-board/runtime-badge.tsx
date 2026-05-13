import * as React from 'react'

export function RuntimeBadge({ runtime }: { runtime: string }) {
  return <span className="runtime-badge">{runtime}</span>
}
