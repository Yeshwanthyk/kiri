import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

const SUPPORTED_LANGS = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'json',
  'bash',
  'python',
  'markdown',
  'css',
  'html',
  'diff',
  'rust',
  'go',
  'zig',
] as const

type SupportedLang = (typeof SUPPORTED_LANGS)[number]

const LANG_ALIAS: Record<string, SupportedLang> = {
  ts: 'typescript',
  typescript: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  javascript: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  bash: 'bash',
  py: 'python',
  python: 'python',
  md: 'markdown',
  markdown: 'markdown',
  css: 'css',
  html: 'html',
  xml: 'html',
  diff: 'diff',
  patch: 'diff',
  rs: 'rust',
  rust: 'rust',
  go: 'go',
  golang: 'go',
  zig: 'zig',
}

export function resolveLang(lang: string | undefined): SupportedLang | null {
  if (!lang) return null
  return LANG_ALIAS[lang.toLowerCase()] ?? null
}

let highlighterPromise: Promise<HighlighterCore> | null = null

function loadHighlighter(): Promise<HighlighterCore> {
  if (highlighterPromise) return highlighterPromise
  highlighterPromise = createHighlighterCore({
    engine: createJavaScriptRegexEngine(),
    themes: [
      import('shiki/themes/github-light.mjs'),
      import('shiki/themes/github-dark.mjs'),
    ],
    langs: [
      import('shiki/langs/typescript.mjs'),
      import('shiki/langs/tsx.mjs'),
      import('shiki/langs/javascript.mjs'),
      import('shiki/langs/jsx.mjs'),
      import('shiki/langs/json.mjs'),
      import('shiki/langs/bash.mjs'),
      import('shiki/langs/python.mjs'),
      import('shiki/langs/markdown.mjs'),
      import('shiki/langs/css.mjs'),
      import('shiki/langs/html.mjs'),
      import('shiki/langs/diff.mjs'),
      import('shiki/langs/rust.mjs'),
      import('shiki/langs/go.mjs'),
      import('shiki/langs/zig.mjs'),
    ],
  })
  return highlighterPromise
}

const MAX_CACHE = 200
const cache = new Map<string, string>()

function cacheGet(key: string): string | undefined {
  const value = cache.get(key)
  if (value !== undefined) {
    cache.delete(key)
    cache.set(key, value)
  }
  return value
}

function cacheSet(key: string, value: string): void {
  if (cache.has(key)) cache.delete(key)
  cache.set(key, value)
  if (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
}

function cacheKey(lang: SupportedLang, code: string): string {
  return `${lang}\u0000${code}`
}

export function highlightCodeSync(code: string, lang: string | undefined): string | null {
  const resolved = resolveLang(lang)
  if (!resolved) return null
  return cacheGet(cacheKey(resolved, code)) ?? null
}

export async function highlightCode(code: string, lang: string | undefined): Promise<string | null> {
  const resolved = resolveLang(lang)
  if (!resolved) return null
  const key = cacheKey(resolved, code)
  const hit = cacheGet(key)
  if (hit) return hit
  const highlighter = await loadHighlighter()
  const html = highlighter.codeToHtml(code, {
    lang: resolved,
    themes: {
      light: 'github-light',
      dark: 'github-dark',
    },
    defaultColor: false,
    cssVariablePrefix: '--shiki-',
  })
  cacheSet(key, html)
  return html
}
