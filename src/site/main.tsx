import React from 'react'
import { createRoot } from 'react-dom/client'
import {
  ArrowDownToLine,
  Check,
  ChevronRight,
  Command,
  Download,
  ExternalLink,
  FolderKanban,
  Keyboard,
  NotebookPen,
  TerminalSquare,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import './site.css'

type ReleaseAsset = {
  readonly name: string
  readonly browserDownloadUrl: string
  readonly size: number
}

type Release = {
  readonly tagName: string
  readonly name: string
  readonly htmlUrl: string
  readonly publishedAt: string
  readonly prerelease: boolean
  readonly assets: readonly ReleaseAsset[]
}

const fallbackReleases: readonly Release[] = [
  {
    tagName: 'v0.1.12',
    name: 'v0.1.12',
    htmlUrl: 'https://github.com/Yeshwanthyk/kiri/releases/tag/v0.1.12',
    publishedAt: '2026-05-19T00:00:00Z',
    prerelease: false,
    assets: [
      {
        name: 'kiri-0.1.12-arm64.dmg',
        browserDownloadUrl:
          'https://github.com/Yeshwanthyk/kiri/releases/download/v0.1.12/kiri-0.1.12-arm64.dmg',
        size: 161_967_997,
      },
    ],
  },
]

const repoUrl = 'https://github.com/Yeshwanthyk/kiri'
const supportedRuntimes = ['Codex', 'Claude Code', 'Pi', 'OpenCode'] as const

const capabilities: ReadonlyArray<{
  readonly icon: LucideIcon
  readonly title: string
  readonly body: string
}> = [
  {
    icon: FolderKanban,
    title: 'Project lanes',
    body: 'Keep each repo, session, cwd, runtime, and hidden state in one board.',
  },
  {
    icon: Keyboard,
    title: 'Keyboard-first',
    body: 'Jump projects, switch tabs, send prompts, and keep terminal flows moving without reaching for the mouse.',
  },
  {
    icon: TerminalSquare,
    title: 'Terminal agents',
    body: 'Open the runtime terminal, paste the prompt, and keep the session alive in Kiri.',
  },
  {
    icon: Check,
    title: 'Timeline context',
    body: 'Keep messages, tool activity, tasks, and session state in one selected-agent view.',
  },
  {
    icon: Command,
    title: 'Agent-first control',
    body: 'CLI operations are shaped for agents first, with compact inputs and durable outputs.',
  },
  {
    icon: NotebookPen,
    title: 'Scratchpad and MCP',
    body: 'Attach scratchpad work and MCP control after the core session surface is in place.',
  },
]

const workflowRows = [
  ['plan', 'split landing, download, release cards'],
  ['spawn', 'open terminal runtime and paste prompt'],
  ['track', 'attach scratchpad block and monitor'],
  ['archive', 'mark the run when the work lands'],
] as const

function App() {
  const [route, setRoute] = React.useState(() => window.location.pathname)

  React.useEffect(() => {
    const onPopState = () => setRoute(window.location.pathname)
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const navigate = React.useCallback((href: string) => {
    window.history.pushState({}, '', href)
    setRoute(window.location.pathname)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  const page = route.startsWith('/download') || route.startsWith('/releases')
    ? <DownloadPage />
    : <LandingPage />

  return (
    <>
      <SiteHeader navigate={navigate} route={route} />
      {page}
      <SiteFooter navigate={navigate} />
    </>
  )
}

function SiteHeader({ navigate, route }: {
  readonly navigate: (href: string) => void
  readonly route: string
}) {
  return (
    <header className="site-header">
      <a
        className="brand"
        href="/"
        onClick={(event) => {
          event.preventDefault()
          navigate('/')
        }}
      >
        <img src="/android-chrome-192x192.png" alt="" />
        <span>kiri</span>
      </a>
      <nav aria-label="Primary">
        <a href="/#workflow">Workflow</a>
        <a
          href="/download"
          data-active={route.startsWith('/download') ? 'true' : undefined}
          onClick={(event) => {
            event.preventDefault()
            navigate('/download')
          }}
        >
          Download
        </a>
        <a href={repoUrl}>GitHub</a>
      </nav>
    </header>
  )
}

function LandingPage() {
  const latest = fallbackReleases[0]
  const dmg = latest.assets[0]
  return (
    <main>
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Local agent control plane</p>
          <h1>kiri is a keyboard-first control plane for local agent work.</h1>
          <p className="hero-lede">
            Start, watch, steer, review, and clean up AI coding sessions across
            projects without losing terminals, scratchpad, shortcuts, timeline context, or run state.
          </p>
          <div className="runtime-badges" aria-label="Supported runtimes">
            {supportedRuntimes.map((runtime) => (
              <span key={runtime}>{runtime}</span>
            ))}
          </div>
          <div className="hero-actions">
            <a className="primary-action" href={dmg.browserDownloadUrl}>
              <Download size={17} aria-hidden="true" />
              Download for Mac
            </a>
            <a className="secondary-action" href="/download">
              Release notes
              <ChevronRight size={16} aria-hidden="true" />
            </a>
          </div>
        </div>
        <ScreenshotShowcase />
      </section>

      <section className="release-strip" aria-label="Latest release">
        <div>
          <span>Latest</span>
          <strong>{latest.tagName}</strong>
        </div>
        <p>{dmg.name} · {formatBytes(dmg.size)} · macOS Apple Silicon</p>
        <a href={latest.htmlUrl}>
          View release
          <ExternalLink size={14} aria-hidden="true" />
        </a>
      </section>

      <section className="section">
        <div className="section-head">
          <p className="eyebrow">Features</p>
          <h2>The daily surface stays fast, local, and keyboard-first.</h2>
        </div>
        <div className="capability-grid">
          {capabilities.map(({ icon: Icon, title, body }) => (
            <article className="capability-card" key={title}>
              <Icon size={18} aria-hidden="true" />
              <h3>{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section" id="workflow">
        <div className="section-head">
          <p className="eyebrow">Workflow runs</p>
          <h2>Then break a plan apart and launch the pieces where they belong.</h2>
        </div>
        <div className="workflow-grid">
          <div className="workflow-card">
            {workflowRows.map(([label, text]) => (
              <div className="workflow-row" key={label}>
                <span>{label}</span>
                <strong>{text}</strong>
              </div>
            ))}
          </div>
          <div className="workflow-card workflow-card-dark">
            <div className="terminal-line"><b>kiri_do</b> workflow.dispatch</div>
            <div className="terminal-line">spawn terminal session</div>
            <div className="terminal-line">paste prompt into PTY</div>
            <div className="terminal-line">track scratchpad + archive</div>
          </div>
        </div>
      </section>

    </main>
  )
}

function DownloadPage() {
  const releases = fallbackReleases
  const latest = releases[0] ?? fallbackReleases[0]
  const primaryAsset = latest.assets.find((asset) => asset.name.endsWith('.dmg')) ?? latest.assets[0]

  return (
    <main className="download-page">
      <section className="download-hero">
        <div>
          <p className="eyebrow">Download</p>
          <h1>Install the latest Kiri desktop build.</h1>
          <p>
            Current public release is {latest.tagName}. The app is local-first:
            sessions, workflows, terminals, and MCP controls run on your Mac.
          </p>
        </div>
        {primaryAsset ? (
          <a className="download-button" href={primaryAsset.browserDownloadUrl}>
            <ArrowDownToLine size={19} aria-hidden="true" />
            {primaryAsset.name}
            <span>{formatBytes(primaryAsset.size)}</span>
          </a>
        ) : null}
      </section>

      <section className="install-panel" aria-labelledby="install-title">
        <div>
          <p className="eyebrow">Install</p>
          <h2 id="install-title">macOS Apple Silicon</h2>
          <p>Download the DMG, open it, then drag Kiri into Applications.</p>
        </div>
        <div className="install-steps">
          <span><Check size={15} aria-hidden="true" /> Desktop app</span>
          <span><Check size={15} aria-hidden="true" /> Local backend</span>
          <span><Check size={15} aria-hidden="true" /> MCP/CLI control</span>
        </div>
      </section>

      <section className="section releases-section">
        <div className="section-head">
          <p className="eyebrow">Releases</p>
          <h2>Published builds</h2>
          <span className="release-status">Release snapshot</span>
        </div>
        <div className="release-list">
          {releases.map((release) => (
            <ReleaseCard release={release} key={release.tagName} />
          ))}
        </div>
      </section>
    </main>
  )
}

function ReleaseCard({ release }: { readonly release: Release }) {
  const dmg = release.assets.find((asset) => asset.name.endsWith('.dmg'))
  return (
    <article className="release-card">
      <div>
        <span>{formatDate(release.publishedAt)}</span>
        <h3>{release.name || release.tagName}</h3>
        <p>{release.prerelease ? 'Prerelease' : 'Stable'} · {release.assets.length} asset</p>
      </div>
      <div className="release-actions">
        {dmg ? (
          <a href={dmg.browserDownloadUrl}>
            <Download size={15} aria-hidden="true" />
            {dmg.name}
          </a>
        ) : null}
        <a href={release.htmlUrl}>
          Notes
          <ExternalLink size={14} aria-hidden="true" />
        </a>
      </div>
    </article>
  )
}

function ScreenshotShowcase() {
  return (
    <div className="screenshot-showcase" aria-label="Kiri app screenshots">
      <figure className="screenshot-card screenshot-card-dark">
        <img
          src="/site/kiri-dark-terminal.png"
          alt="Kiri dark theme showing a Claude terminal session inside a project board."
        />
      </figure>
      <figure className="screenshot-card screenshot-card-light">
        <img
          src="/site/kiri-light-chat.png"
          alt="Kiri light theme showing chat, project sessions, scratchpad, and release notes."
        />
      </figure>
    </div>
  )
}

function SiteFooter({ navigate }: { readonly navigate: (href: string) => void }) {
  return (
    <footer className="site-footer">
      <span>kiri</span>
      <a
        href="/download"
        onClick={(event) => {
          event.preventDefault()
          navigate('/download')
        }}
      >
        Download
      </a>
      <a href={`${repoUrl}/releases`}>Releases</a>
      <a href={repoUrl}>GitHub</a>
    </footer>
  )
}

function formatBytes(bytes: number) {
  const mb = bytes / 1024 / 1024
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value))
}

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root')
createRoot(root).render(<App />)
