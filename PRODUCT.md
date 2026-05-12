# Product

## Register

product

## Users

Senior engineers running multiple AI coding agents in parallel across local
repos. They live in a terminal and editor flow (Pi, Codex, Claude),
prefer keyboard over mouse, and use Aether as a control plane to start, watch,
and discard sessions without leaving the keyboard. Many of them run tiling
window managers and treat their tools as one continuous workspace.

## Product Purpose

A keyboard-first kanban orchestrator for agent sessions. Each project is a row,
each session a card. Aether launches sessions against a chosen runtime/model,
parses JSONL transcripts into a SQLite read model, and exposes diffs through
Pierre. Success: a power user starts, switches between, reviews, and kills
agent sessions faster than they could in raw terminals, with the whole
workspace legible at a glance.

## Brand Personality

Editor-adjacent, calm, precise. The voice is that of a senior tool author:
short sentences, no marketing language, no exclamation. Surfaces feel
inhabited like Zed or Helix, not promoted like a SaaS dashboard.

## Anti-references

- **SaaS dashboards** (Vercel, Resend, Stripe-style): hero-metric tiles,
  gradient cards, illustration, "Welcome back" greetings.
- **AI-product aesthetic**: purple gradients, sparkles, "magic" glow, mascot,
  chat-first framing, gradient text.
- **Notion/Coda doc surfaces**: airy empty whitespace, emoji-driven hierarchy,
  page-as-blog tone.
- **Linear's form-driven kanban**: status pills, assignee avatars, label
  matrices, hover-menu density. Aether borrows Linear's craft and respect for
  density, not its product surface.

## Design Principles

1. **Keyboard is the primary surface.** Every action has a key. Mouse paths
   exist as a courtesy. Visual design supports shortcut discovery and muscle
   memory; it never competes with the keystroke.
2. **Tile, don't stack.** Following the niri philosophy: surfaces flow
   horizontally, scroll instead of paginate, and never trap the user in modal
   stacks. The board scrolls; settings scroll; nothing is buried.
3. **Read at a glance, act in one keystroke.** The interface is a status
   display first. Controls reveal contextually, never preemptively.
4. **Themed, not branded.** Seven themes ship (aether, vesper, github,
   tokyonight, catppuccin, gruvbox, rosepine) because users bring their editor
   palette with them. The product respects that choice. No fixed brand color
   overrides the active theme.
5. **Local-first honesty.** SQLite under `.aether/`, `settings.json` on disk.
   The UI should feel like inspecting the file system, not a cloud product.
   When state lives on disk, the UI says so.

## Accessibility & Inclusion

No formal WCAG target. Don't ship regressions: keep focus rings visible across
all themes, never drop below the contrast already present in the theme tokens,
honor `prefers-reduced-motion` for any new motion added.
