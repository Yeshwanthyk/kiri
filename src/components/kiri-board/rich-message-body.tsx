'use client'

import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import * as React from 'react'
import { highlightCode, highlightCodeSync } from '../../lib/code-highlighter'

export const RichMessageBody = React.memo(function RichMessageBody({
  text,
  compact = false,
}: {
  text: string
  compact?: boolean
}) {
  return (
    <div className={compact ? 'rich-message-body compact' : 'rich-message-body'}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  )
})

function extractCodeText(node: React.ReactNode): string {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractCodeText).join('')
  if (React.isValidElement(node)) {
    return extractCodeText((node.props as { children?: React.ReactNode }).children)
  }
  return ''
}

const HighlightedPre = React.memo(function HighlightedPre({
  code,
  lang,
  fallback,
}: {
  code: string
  lang: string | undefined
  fallback: React.ReactNode
}) {
  const [html, setHtml] = React.useState<string | null>(() => highlightCodeSync(code, lang))

  React.useEffect(() => {
    if (html !== null) return
    let cancelled = false
    const run = () => {
      void highlightCode(code, lang).then((next) => {
        if (!cancelled && next) setHtml(next)
      })
    }
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void) => number
      cancelIdleCallback?: (id: number) => void
    }
    if (typeof w.requestIdleCallback === 'function') {
      const id = w.requestIdleCallback(run)
      return () => {
        cancelled = true
        w.cancelIdleCallback?.(id)
      }
    }
    const timer = window.setTimeout(run, 0)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [code, lang, html])

  if (html) {
    return <div className="shiki-block" dangerouslySetInnerHTML={{ __html: html }} />
  }
  return <pre>{fallback}</pre>
})

const markdownComponents = {
  a({ children, ...props }) {
    return (
      <a {...props} target="_blank" rel="noreferrer">
        {children}
      </a>
    )
  },
  pre({ children }) {
    const child = React.Children.toArray(children).find(React.isValidElement)
    if (!child) return <pre>{children}</pre>
    const childProps = child.props as { className?: string; children?: React.ReactNode }
    const match = /language-([\w-]+)/.exec(childProps.className ?? '')
    const lang = match ? match[1] : undefined
    const raw = extractCodeText(childProps.children)
    const code = raw.endsWith('\n') ? raw.slice(0, -1) : raw
    return <HighlightedPre code={code} lang={lang} fallback={children} />
  },
} satisfies Components

const remarkPlugins = [remarkGfm]
