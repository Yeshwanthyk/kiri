import { Link, createFileRoute } from '@tanstack/react-router'
import {
  Check,
  Command,
  FolderOpen,
  GitPullRequest,
  MessageSquareText,
  NotebookPen,
  Plus,
  Settings2,
  TerminalSquare,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { seo } from '~/utils/seo'

export const Route = createFileRoute('/landing')({
  head: () => ({
    meta: [
      ...seo({
        title: 'kiri: keyboard-first agent sessions',
        description:
          'A local control plane for starting, watching, steering, reviewing, and cleaning up AI coding sessions across projects.',
      }),
    ],
  }),
  component: Landing,
})

const agentGroups = [
  {
    name: 'api-service',
    count: '1 session',
    cards: [
      {
        title: 'Session 16',
        preview: 'Ready. Claude terminal attached with repository context preserved.',
        runtime: 'claude',
        meta: '0 msg',
        active: true,
      },
    ],
  },
  {
    name: 'kiri',
    count: '2 sessions',
    cards: [
      {
        title: 'Research OpenCode terminal flow',
        preview: 'Recommendation: add OpenCode as a terminal-only runtime like Claude.',
        runtime: 'codex',
        meta: '27 msg',
      },
      {
        title: 'Audit Codex terminal tests',
        preview: 'Changed: resume support, stale guards, fake terminal harness, E2E.',
        runtime: 'codex',
        meta: '139 msg',
      },
    ],
  },
  {
    name: 'merlin',
    count: '2 sessions',
    cards: [
      {
        title: 'Signal channel adapter',
        preview: 'Running gateway, attachment cache, safe group defaults.',
        runtime: 'codex',
        meta: '292 msg',
      },
      {
        title: 'Session 4',
        preview: 'Ready.',
        runtime: 'claude',
        meta: '0 msg',
      },
    ],
  },
]

const tabs: Array<{ icon: LucideIcon; label: string; active?: boolean; count?: string }> = [
  { icon: MessageSquareText, label: 'Chat', active: true },
  { icon: GitPullRequest, label: 'Diffs' },
  { icon: TerminalSquare, label: 'Terminal' },
  { icon: NotebookPen, label: 'Scratchpad', count: '6' },
]

const transcriptRows = [
  ['Prompt', 'ship the landing as the product surface, not a generic hero'],
  ['Task', 'Read cmux reference, inspect current kiri UI, rebuild preview'],
  ['Diff', 'landing route and scoped CSS updated'],
  ['Terminal', 'pnpm build passed'],
]

const capabilities: Array<{ icon: LucideIcon; title: string; body: string }> = [
  {
    icon: FolderOpen,
    title: 'Project lanes',
    body: 'Each repo keeps its sessions, hidden state, cwd, runtime choices, and history in one visible row.',
  },
  {
    icon: Command,
    title: 'Keyboard movement',
    body: 'Move between projects, sessions, tabs, terminal focus, and the command menu without changing posture.',
  },
  {
    icon: TerminalSquare,
    title: 'Terminal agents',
    body: 'Claude and shell sessions run in persistent panes that survive tab switches and expose their cwd.',
  },
  {
    icon: GitPullRequest,
    title: 'Review surface',
    body: 'Diffs render beside the conversation, so review is a panel, not a pasted transcript.',
  },
  {
    icon: NotebookPen,
    title: 'Scratchpad launch',
    body: 'Capture work, choose a target project and runtime, then trigger it into a session.',
  },
  {
    icon: Settings2,
    title: 'Local control',
    body: 'SQLite, settings.json, CLI, desktop helper, and MCP all talk to the same local control plane.',
  },
]

const why = [
  'Raw terminal tabs lose agent state once enough work is running.',
  'Chat-only tools hide tasks, diffs, terminals, and project targeting.',
  'A local engineer workflow needs primitives that fit existing repos.',
  'The board should tell you what is running and where to jump next.',
]

const shortcuts = [
  ['Shift J/K', 'move agents'],
  ['Shift H/L', 'move projects'],
  ['Shift N', 'new session'],
  ['Shift Tab', 'terminal focus'],
  ['Command K', 'command menu'],
]

function Landing() {
  return (
    <main className="landing-shell">
      <section className="landing-product-stage" aria-labelledby="landing-title">
        <AppPreview />
      </section>

      <section className="landing-story-strip" aria-labelledby="landing-title">
        <div>
          <p className="landing-kicker">Local agent control plane</p>
          <h1 id="landing-title">kiri keeps agent work shaped like your workspace.</h1>
        </div>
        <p>
          It was made for engineers running several AI coding agents at once:
          left side for projects and sessions, right side for the selected
          agent, with chat, diffs, terminal, and scratchpad in reach.
        </p>
      </section>

      <section id="capabilities" className="landing-section" aria-labelledby="capabilities-title">
        <div className="landing-section-head">
          <p className="landing-kicker">What it can do</p>
          <h2 id="capabilities-title">The working parts stay visible.</h2>
        </div>
        <div className="landing-capability-grid">
          {capabilities.map(({ icon: Icon, title, body }) => (
            <article className="landing-capability" key={title}>
              <Icon size={17} aria-hidden="true" />
              <h3>{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="why" className="landing-section landing-why" aria-labelledby="why-title">
        <div className="landing-section-head">
          <p className="landing-kicker">Why it exists</p>
          <h2 id="why-title">The bottleneck is not starting agents. It is seeing them clearly.</h2>
        </div>
        <div className="landing-why-list">
          {why.map((item) => (
            <div className="landing-why-item" key={item}>
              <Check size={16} aria-hidden="true" />
              <span>{item}</span>
            </div>
          ))}
        </div>
      </section>

      <section id="media" className="landing-section landing-media" aria-labelledby="media-title">
        <div className="landing-section-head">
          <p className="landing-kicker">Media slots</p>
          <h2 id="media-title">Add video where the app already has surfaces.</h2>
        </div>
        <div className="landing-media-grid">
          <MediaSlot title="Board navigation" body="Show project and agent movement from the left rail." />
          <MediaSlot title="Agent detail" body="Show chat, task strip, pending questions, and scratchpad." />
          <MediaSlot title="Diff and terminal" body="Show review pane, terminal resume, and typecheck proof." />
        </div>
      </section>
    </main>
  )
}

function AppPreview() {
  return (
    <div className="landing-app-frame" aria-label="kiri interface preview">
      <aside className="landing-agent-sidebar">
        <header className="landing-sidebar-top">
          <Link to="/" className="landing-mark" aria-label="Open kiri board">
            kiri
          </Link>
          <div className="landing-sidebar-actions">
            <a href="#capabilities">
              <FolderOpen size={15} aria-hidden="true" />
              Projects
            </a>
            <a href="#why">
              <Settings2 size={15} aria-hidden="true" />
              Why
            </a>
          </div>
        </header>

        <div className="landing-agent-list">
          {agentGroups.map((group) => (
            <section className="landing-agent-group" key={group.name}>
              <h2>
                {group.name}
                <span>{group.count}</span>
              </h2>
              <div className="landing-agent-cards">
                {group.cards.map((card) => (
                  <article
                    className="landing-agent-card"
                    data-active={'active' in card && card.active ? 'true' : undefined}
                    key={`${group.name}-${card.title}`}
                  >
                    <div>
                      <h3>{card.title}</h3>
                      <time>8h</time>
                    </div>
                    <p>{card.preview}</p>
                    <footer>
                      <span>{card.meta}</span>
                      <strong>{card.runtime}</strong>
                    </footer>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>

        <footer className="landing-hidden-row" aria-label="Hidden projects">
          <span>Hidden 6</span>
          <div>
            <span>resq-fullstack</span>
            <span>gitgud</span>
            <span>dump</span>
          </div>
        </footer>
      </aside>

      <section className="landing-agent-detail">
        <header className="landing-detail-topbar">
          <p>
            <span />
            api-service
            <b>session-mp79j1in-071hvr</b>
            claude-opus-4-7:medium
          </p>
          <Link to="/" className="landing-open-app">
            Open app
            <TerminalSquare size={15} aria-hidden="true" />
          </Link>
        </header>

        <nav className="landing-detail-tabs" aria-label="Agent tabs">
          {tabs.map(({ icon: Icon, label, active, count }) => (
            <span data-active={active ? 'true' : undefined} key={label}>
              <Icon size={16} aria-hidden="true" />
              {label}
              {count ? <b>{count}</b> : null}
            </span>
          ))}
        </nav>

        <div className="landing-agent-work">
          <section className="landing-chat-pane" aria-label="Selected agent detail">
            <header>
              <div>
                <p className="landing-kicker">Agent terminal</p>
                <h2>~/projects/api-service</h2>
              </div>
              <span>Connected</span>
            </header>

            <div className="landing-terminal-window">
              <p>
                <b>Test coverage</b>
              </p>
              <p>- Slack: session_manager_status/status_and_artifacts.rs</p>
              <p>- Linear: integration gap worth filling</p>
              <p />
              <p>
                <b>Decision points</b>
              </p>
              <p>1. Wording: keep external phrasing friendly.</p>
              <p>2. Scope: keep the change minimal unless the test fails.</p>
              <p>3. Verification: run focused proof before shipping.</p>
            </div>

            <div className="landing-transcript-rows">
              {transcriptRows.map(([label, text]) => (
                <div className="landing-transcript-row" key={label}>
                  <span>{label}</span>
                  <strong>{text}</strong>
                </div>
              ))}
            </div>

            <footer className="landing-prompt-bar">
              <span>~/projects/api-service [feature/agent-session-board]</span>
              <strong>bypass permissions on</strong>
            </footer>
          </section>

          <aside className="landing-right-rail">
            <div className="landing-command-card">
              <p className="landing-kicker">Keyboard</p>
              {shortcuts.map(([key, label]) => (
                <div key={key}>
                  <kbd>{key}</kbd>
                  <span>{label}</span>
                </div>
              ))}
            </div>
            <div className="landing-command-card">
              <p className="landing-kicker">Why this shape</p>
              <p>
                kiri borrows the useful part of terminal multiplexers: visible
                running work. It adds the read model agents need: sessions,
                tasks, diffs, scratchpad, and project targeting.
              </p>
            </div>
          </aside>
        </div>
      </section>
    </div>
  )
}

function MediaSlot({ title, body }: { title: string; body: string }) {
  return (
    <figure className="landing-media-card">
      <div className="landing-media-frame">
        <Plus size={18} aria-hidden="true" />
      </div>
      <figcaption>
        <strong>{title}</strong>
        <span>{body}</span>
      </figcaption>
    </figure>
  )
}
