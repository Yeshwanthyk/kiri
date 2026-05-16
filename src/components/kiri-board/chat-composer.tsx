'use client'

import { ImagePlus, Send, Square } from 'lucide-react'
import * as React from 'react'
import type { AgentCell, SendMessageImage } from '~/lib/contracts'
import { errorMessage, formatTokenCount } from './format'
import { imageKey, readImageFile } from './images'
import { readStoredChatDraft, updateChatDraft } from './storage'

export function ChatComposer({
  agentId,
  contextUsage,
  focusRequest,
  isBackendRunning,
  isRunning,
  pending,
  onError,
  onInterrupt,
  onSubmitPrompt,
  onEmptyChange,
}: {
  agentId: string
  contextUsage: AgentCell['contextUsage']
  focusRequest: number
  isBackendRunning: boolean
  isRunning: boolean
  pending: boolean
  onError: React.Dispatch<React.SetStateAction<string | null>>
  onInterrupt: () => Promise<void>
  onSubmitPrompt: (
    prompt: string,
    images: SendMessageImage[],
    clearComposer: () => void,
  ) => Promise<void>
  onEmptyChange?: (empty: boolean) => void
}) {
  const [draft, setDraft] = React.useState(() => readStoredChatDraft(agentId))
  const [images, setImages] = React.useState<SendMessageImage[]>([])
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)
  const hasDraftContent = draft.trim().length > 0 || images.length > 0

  React.useEffect(() => {
    onEmptyChange?.(!hasDraftContent)
  }, [hasDraftContent, onEmptyChange])
  const canInterrupt = isBackendRunning && !hasDraftContent
  const canSteer = isBackendRunning && hasDraftContent
  const canSend = !isRunning && hasDraftContent
  const canSubmit = !pending && (canSend || canSteer || canInterrupt)

  React.useEffect(() => {
    setDraft(readStoredChatDraft(agentId))
    setImages([])
  }, [agentId])

  React.useEffect(() => {
    if (focusRequest === 0) return
    textareaRef.current?.focus()
  }, [focusRequest])

  function setStoredDraft(value: string) {
    updateChatDraft(agentId, value, setDraft)
  }

  function clearComposer() {
    updateChatDraft(agentId, '', setDraft)
    setImages([])
  }

  async function addImageFiles(files: File[]) {
    const imageFiles = files.filter((file) => file.type.startsWith('image/'))
    if (!imageFiles.length) return
    try {
      const remaining = Math.max(4 - images.length, 0)
      const nextImages = await Promise.all(imageFiles.slice(0, remaining).map(readImageFile))
      if (imageFiles.length > remaining) {
        onError('Attach up to 4 images per message')
      }
      setImages((current) => [...current, ...nextImages].slice(0, 4))
    } catch (cause) {
      onError(errorMessage(cause))
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSubmit) return
    if (canInterrupt) {
      await onInterrupt()
      return
    }
    const prompt = draft.trim() || 'Please inspect the attached image files.'
    await onSubmitPrompt(prompt, images, clearComposer)
  }

  return (
    <form className="composer" onSubmit={(event) => void submit(event)}>
      <div className="composer-fields">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => setStoredDraft(event.currentTarget.value)}
          onPaste={(event) => {
            void addImageFiles(Array.from(event.clipboardData.files))
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.currentTarget.blur()
              return
            }
            if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey) return
            event.preventDefault()
            event.currentTarget.form?.requestSubmit()
          }}
          aria-label="Prompt"
          placeholder="Type to this agent"
          rows={3}
          data-testid="chat-input"
        />
        {images.length ? (
          <div className="composer-attachments" aria-label="Attached images">
            {images.map((image, index) => (
              <span key={imageKey(image)} className="composer-attachment">
                {image.name}
                <button
                  type="button"
                  onClick={() =>
                    setImages((current) => current.filter((_, itemIndex) => itemIndex !== index))
                  }
                  aria-label={`Remove ${image.name}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        hidden
        onChange={(event) => {
          void addImageFiles(Array.from(event.currentTarget.files ?? []))
          event.currentTarget.value = ''
        }}
      />
      <span className="composer-hint">Enter to send · Shift Enter for newline</span>
      <button
        type="button"
        className="composer-attach"
        onClick={() => fileInputRef.current?.click()}
        aria-label="Attach images"
        title="Attach images"
      >
        <ImagePlus size={15} />
      </button>
      <ContextUsageChip usage={contextUsage} />
      <button
        type="submit"
        className={`composer-submit${canInterrupt ? ' interrupt' : ''}${canSteer ? ' steer' : ''}`}
        disabled={!canSubmit}
        aria-label={canInterrupt ? 'Stop generation' : canSteer ? 'Steer agent' : 'Send prompt'}
        title={canInterrupt ? 'Stop generation' : canSteer ? 'Steer this turn' : isRunning ? 'Starting turn' : 'Send prompt'}
      >
        {canInterrupt ? <Square size={13} fill="currentColor" /> : <Send size={15} />}
      </button>
    </form>
  )
}

function ContextUsageChip({
  usage,
}: {
  usage: AgentCell['contextUsage']
}) {
  if (!usage) return null

  const usedPercent = Math.round(usage.usedPercent)
  const remainingPercent = Math.max(100 - usedPercent, 0)
  const normalizedPercent = Math.max(0, Math.min(100, usage.usedPercent))

  return (
    <button
      type="button"
      className="context-chip"
      aria-label={`${formatTokenCount(usage.usedTokens)} of ${formatTokenCount(usage.windowTokens)} context tokens used`}
      title={`${usedPercent}% used (${remainingPercent}% left), ${usage.usedTokens.toLocaleString('en')} / ${usage.windowTokens.toLocaleString('en')} tokens used`}
      style={{ '--context-used': `${normalizedPercent}%` } as React.CSSProperties}
    >
      <span className="context-chip-battery" aria-hidden="true">
        <span />
      </span>
      <strong>{usedPercent}</strong>
    </button>
  )
}
