import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  kiriReadOperations,
  kiriWriteOperations,
} from '~/lib/contracts'

describe('kiri-control skill doc operation surface', () => {
  it('mentions every supported kiri-control operation', () => {
    const doc = readFileSync(
      join(process.cwd(), '.agents/skills/kiri-control/SKILL.md'),
      'utf8',
    )

    const missing = [...kiriReadOperations, ...kiriWriteOperations]
      .filter((operation) => !doc.includes(`\`${operation}\``))

    expect(missing).toEqual([])
  })
})
