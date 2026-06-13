import * as React from 'react'

export function useFocusReturn(returnFocusElement?: HTMLElement | null) {
  const previousFocusRef = React.useRef<HTMLElement | null>(null)
  React.useEffect(() => {
    previousFocusRef.current = returnFocusElement ??
      (document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null)
    return () => {
      previousFocusRef.current?.focus()
    }
  }, [returnFocusElement])
}

export function trapTabFocus(event: React.KeyboardEvent, container: HTMLElement | null) {
  if (event.key !== 'Tab' || !container) return

  const focusable = focusableElements(container)
  if (focusable.length === 0) return

  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const active = document.activeElement

  if (!(active instanceof HTMLElement) || !container.contains(active)) {
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus()
    return
  }

  if (event.shiftKey && active === first) {
    event.preventDefault()
    last.focus()
    return
  }

  if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
  }
}

export function focusableElements(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      [
        'a[href]',
        'button:not([disabled])',
        'input:not([disabled])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        '[tabindex]:not([tabindex="-1"])',
      ].join(','),
    ),
  ).filter((element) => element.offsetParent !== null)
}
