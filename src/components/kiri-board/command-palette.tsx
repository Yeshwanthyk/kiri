'use client'

import { Command } from 'lucide-react'
import * as React from 'react'
import type { CommandPaletteAction } from './board-types'
import { trapTabFocus, useFocusReturn } from './dialog-focus'

export function CommandPalette({
  actions,
  onClose,
}: {
  actions: CommandPaletteAction[]
  onClose: () => void
}) {
  const panelRef = React.useRef<HTMLDivElement | null>(null)
  const [query, setQuery] = React.useState('')
  const [selectedIndex, setSelectedIndex] = React.useState(0)
  const inputRef = React.useRef<HTMLInputElement>(null)
  useFocusReturn()

  React.useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const normalizedQuery = query.trim().toLowerCase()
  const queryTerms = normalizedQuery.split(/\s+/).filter(Boolean)
  const filteredActions = actions.filter((action) => {
    const haystack = `${action.title} ${action.detail}`.toLowerCase()
    return queryTerms.every((term) => haystack.includes(term))
  })
  const visibleActions = normalizedQuery ? filteredActions : filteredActions.slice(0, 7)
  const selectedAction = visibleActions[selectedIndex]

  React.useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  React.useEffect(() => {
    if (selectedIndex >= visibleActions.length) setSelectedIndex(0)
  }, [selectedIndex, visibleActions.length])

  function moveSelection(delta: number) {
    const enabledIndexes = visibleActions.flatMap((action, index) =>
      action.disabled ? [] : [index],
    )
    if (enabledIndexes.length === 0) return

    const currentEnabledIndex = enabledIndexes.indexOf(selectedIndex)
    const nextEnabledIndex =
      currentEnabledIndex < 0
        ? 0
        : (currentEnabledIndex + delta + enabledIndexes.length) % enabledIndexes.length
    setSelectedIndex(enabledIndexes[nextEnabledIndex])
  }

  function submit(action: CommandPaletteAction | undefined) {
    const fallbackAction = visibleActions.find((item) => !item.disabled)
    const actionToRun = action && !action.disabled ? action : fallbackAction
    if (!actionToRun) return
    actionToRun.run()
  }

  return (
    <div
      ref={panelRef}
      className="command-panel"
      role="dialog"
      aria-modal="true"
      aria-label="Command menu"
      onKeyDown={(event) => trapTabFocus(event, panelRef.current)}
    >
      <div className="command-search">
        <Command size={16} aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              onClose()
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              moveSelection(1)
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              moveSelection(-1)
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              submit(selectedAction)
            }
          }}
          aria-activedescendant={selectedAction ? `command-${selectedAction.id}` : undefined}
          placeholder="Start, end, or switch"
          aria-label="Command search"
          data-testid="command-search"
        />
        <span>⌘K</span>
      </div>
      <div className="command-list" role="listbox" aria-label="Commands">
        {visibleActions.length > 0 ? (
          visibleActions.map((action, index) => {
            const Icon = action.icon
            return (
              <button
                key={action.id}
                type="button"
                id={`command-${action.id}`}
                className={`command-item ${index === selectedIndex ? 'active' : ''}`}
                disabled={action.disabled}
                role="option"
                aria-selected={index === selectedIndex}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => submit(action)}
              >
                <Icon size={15} aria-hidden="true" />
                <span>
                  <strong>{action.title}</strong>
                  <small>{action.detail}</small>
                </span>
              </button>
            )
          })
        ) : (
          <p className="command-empty">No command matches.</p>
        )}
      </div>
    </div>
  )
}
