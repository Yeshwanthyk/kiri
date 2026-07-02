import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import {
  agentPresenceShellCommand,
  parseAgentPresenceOsc,
  renderAgentPresenceOscPayload,
} from '~/server/agent-presence'

describe('agent presence OSC', () => {
  it('parses status events with optional pid', () => {
    expect(parseAgentPresenceOsc('start=claude;event=busy;pid=1234')).toEqual({
      agent: 'claude',
      event: 'busy',
      pid: 1234,
    })
    expect(parseAgentPresenceOsc('end=claude;event=session_end')).toEqual({
      agent: 'claude',
      event: 'session_end',
    })
  })

  it('parses base64 notify events', () => {
    expect(parseAgentPresenceOsc([
      'start=codex',
      'kind=notify',
      `title=${Buffer.from('Needs input').toString('base64')}`,
      `body=${Buffer.from('Pick an option').toString('base64')}`,
    ].join(';'))).toEqual({
      agent: 'codex',
      kind: 'notify',
      title: 'Needs input',
      body: 'Pick an option',
    })
  })

  it('rejects malformed, unknown, and oversized payloads', () => {
    expect(parseAgentPresenceOsc('start=unknown;event=busy')).toBeNull()
    expect(parseAgentPresenceOsc('start=claude;event=nope')).toBeNull()
    expect(parseAgentPresenceOsc('start=claude;event=busy;pid=0')).toBeNull()
    expect(parseAgentPresenceOsc('end=claude;event=busy')).toBeNull()
    expect(parseAgentPresenceOsc('start=claude;kind=notify;title=not base64;body=ok')).toBeNull()
    expect(parseAgentPresenceOsc('x'.repeat(8_193))).toBeNull()
  })

  it('renders shell-safe presence commands', () => {
    expect(renderAgentPresenceOscPayload('claude', 'session_end'))
      .toBe('end=claude;event=session_end')
    expect(agentPresenceShellCommand('claude', 'busy'))
      .toBe('printf \'\\033]3008;start=claude;event=busy;pid=%d\\033\\\\\' "$PPID" > /dev/tty 2>/dev/null || true')
  })
})
