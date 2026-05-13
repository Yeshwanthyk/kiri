import type { SendMessageImage } from '~/lib/contracts'

export function pendingPromptText(text: string, images: SendMessageImage[]) {
  if (!images.length) return text
  return `${text}\n\nAttached images:\n${images.map((image) => `- ${image.name}`).join('\n')}`
}

export function imageKey(image: SendMessageImage) {
  return `${image.name}:${image.mimeType}:${image.data.length}:${hashString(image.data)}`
}

function hashString(value: string) {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0
  }
  return hash.toString(36)
}

export async function readImageFile(file: File): Promise<SendMessageImage> {
  if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) {
    throw new Error(`Unsupported image type: ${file.type || file.name}`)
  }
  if (file.size > 5 * 1024 * 1024) {
    throw new Error(`Image "${file.name}" is larger than 5MB`)
  }
  const dataUrl = await readFileAsDataUrl(file)
  const [, data] = dataUrl.split(',', 2)
  if (!data) throw new Error(`Could not read image "${file.name}"`)
  return {
    name: file.name || 'image',
    mimeType: file.type,
    data,
  }
}

function readFileAsDataUrl(file: File) {
  return file.arrayBuffer().then((buffer) => {
    const base64 = arrayBufferToBase64(buffer)
    return `data:${file.type};base64,${base64}`
  })
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  let binary = ''
  const bytes = new Uint8Array(buffer)
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}
