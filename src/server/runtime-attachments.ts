import { mkdirSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { SendMessageImage } from '~/lib/contracts'
import type { KiriConfig } from './kiri-config'
import { attachmentDirPath, getKiriConfig } from './kiri-config'

const maxPromptImageBytes = 5 * 1024 * 1024
const imageFileExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.gif'] as const

export function promptWithSavedImages(
  agentId: string,
  text: string,
  images: readonly SendMessageImage[],
  options: {
    readonly now?: () => number
    readonly config?: KiriConfig
  } = {},
) {
  if (images.length === 0) return text

  const paths = images.map((image, index) => savePromptImage(agentId, image, index, options))
  return `${text.trim()}\n\nAttached image files:\n${paths
    .map((path) => `- ${path}`)
    .join('\n')}\n\nUse these file paths if you need to inspect the images.`
}

function savePromptImage(
  agentId: string,
  image: SendMessageImage,
  index: number,
  options: {
    readonly now?: () => number
    readonly config?: KiriConfig
  },
) {
  const bytes = Buffer.from(image.data, 'base64')
  if (bytes.length > maxPromptImageBytes) {
    throw new Error(`Image "${image.name}" is larger than 5MB`)
  }

  const dir = attachmentDirPath(options.config ?? getKiriConfig(), agentId)
  mkdirSync(dir, { recursive: true })
  const path = join(
    dir,
    `${(options.now ?? Date.now)()}-${index + 1}-${safePathSegment(image.name, 'image')}${imageExtension(image)}`,
  )
  writeFileSync(path, bytes, { flag: 'wx' })
  return path
}

function imageExtension(image: SendMessageImage) {
  const existing = extname(image.name).toLowerCase()
  if ((imageFileExtensions as readonly string[]).includes(existing)) return ''
  if (image.mimeType === 'image/png') return '.png'
  if (image.mimeType === 'image/webp') return '.webp'
  if (image.mimeType === 'image/gif') return '.gif'
  return '.jpg'
}

function safePathSegment(value: string, fallback = 'attachment') {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || fallback
}
