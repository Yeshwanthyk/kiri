import { describe, expect, it } from 'vitest'
import { imageKey, pendingPromptText, readImageFile } from '../../src/components/aether-board/images'
import type { SendMessageImage } from '../../src/lib/contracts'

describe('aether-board image helpers', () => {
  it('appends attachment names to the prompt text sent to providers', () => {
    const images: SendMessageImage[] = [
      { name: 'first.png', mimeType: 'image/png', data: 'aaa' },
      { name: 'second.webp', mimeType: 'image/webp', data: 'bbb' },
    ]

    expect(pendingPromptText('look', images)).toBe(
      'look\n\nAttached images:\n- first.png\n- second.webp',
    )
    expect(pendingPromptText('look', [])).toBe('look')
  })

  it('uses the full image payload when building a stable React key', () => {
    const base: SendMessageImage = {
      name: 'same.png',
      mimeType: 'image/png',
      data: `${'a'.repeat(64)}b`,
    }
    const samePrefixDifferentTail: SendMessageImage = {
      ...base,
      data: `${'a'.repeat(64)}c`,
    }

    expect(imageKey(base)).not.toBe(imageKey(samePrefixDifferentTail))
  })

  it('reads supported image files into provider payloads', async () => {
    const file = new File(['hello'], 'preview.png', { type: 'image/png' })

    await expect(readImageFile(file)).resolves.toEqual({
      name: 'preview.png',
      mimeType: 'image/png',
      data: 'aGVsbG8=',
    })
  })

  it('rejects unsupported and oversized image files before reading content', async () => {
    const textFile = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    const largeImage = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.png', {
      type: 'image/png',
    })

    await expect(readImageFile(textFile)).rejects.toThrow('Unsupported image type')
    await expect(readImageFile(largeImage)).rejects.toThrow('larger than 5MB')
  })
})
