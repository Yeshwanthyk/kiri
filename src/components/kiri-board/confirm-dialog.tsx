'use client'

import { AlertTriangle } from 'lucide-react'
import * as React from 'react'
import { trapTabFocus, useFocusReturn } from './dialog-focus'

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel,
  destructive,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string
  body: React.ReactNode
  confirmLabel: string
  cancelLabel: string
  destructive?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const dialogRef = React.useRef<HTMLDivElement | null>(null)
  const confirmRef = React.useRef<HTMLButtonElement | null>(null)

  useFocusReturn()

  React.useEffect(() => {
    confirmRef.current?.focus()
  }, [])

  return (
    <>
      <button
        type="button"
        className="session-dialog-scrim"
        onClick={onCancel}
        aria-label="Cancel confirmation"
      />
      <div
        ref={dialogRef}
        className={`session-dialog confirm-dialog${destructive ? ' confirm-dialog-destructive' : ''}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          } else if (event.key === 'Enter') {
            event.preventDefault()
            if (!busy) onConfirm()
          } else {
            trapTabFocus(event, dialogRef.current)
          }
        }}
        data-testid="confirm-dialog"
      >
        <div className="confirm-dialog-head">
          <span className="confirm-dialog-icon" aria-hidden="true">
            <AlertTriangle size={16} />
          </span>
          <div>
            <p className="settings-kicker">Confirm</p>
            <strong id="confirm-dialog-title">{title}</strong>
          </div>
        </div>
        <p className="confirm-dialog-body">{body}</p>
        <div className="session-dialog-actions">
          <button
            type="button"
            className="confirm-dialog-cancel"
            onClick={onCancel}
            disabled={busy}
            data-testid="confirm-dialog-cancel"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="confirm-dialog-confirm"
            onClick={onConfirm}
            disabled={busy}
            data-testid="confirm-dialog-confirm"
          >
            {busy ? 'Removing…' : confirmLabel}
          </button>
        </div>
      </div>
    </>
  )
}
