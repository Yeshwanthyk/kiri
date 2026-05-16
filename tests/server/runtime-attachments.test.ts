import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { KiriConfig } from '~/server/kiri-config'
import { promptWithSavedImages } from '~/server/runtime-attachments'

describe('runtime prompt attachments', () => {
  it('saves prompt images with sanitized names and mime-derived extensions', () => {
    const config = testConfig()
    const prompt = promptWithSavedImages('agent/one', ' inspect ', [{
      name: '../screen shot',
      mimeType: 'image/png',
      data: Buffer.from('png').toString('base64'),
    }, {
      name: 'already.webp',
      mimeType: 'image/jpeg',
      data: Buffer.from('webp').toString('base64'),
    }, {
      name: 'unknown',
      mimeType: 'application/octet-stream',
      data: Buffer.from('jpg').toString('base64'),
    }], {
      config,
      now: () => 123,
    })

    expect(prompt).toContain('inspect')
    expect(prompt).toContain('123-1-..-screen-shot.png')
    expect(prompt).toContain('123-2-already.webp')
    expect(prompt).toContain('123-3-unknown.jpg')
    expect(readFileSync(join(config.attachmentsDir, 'agent-one', '123-1-..-screen-shot.png'), 'utf8')).toBe('png')
    expect(readFileSync(join(config.attachmentsDir, 'agent-one', '123-2-already.webp'), 'utf8')).toBe('webp')
    expect(readFileSync(join(config.attachmentsDir, 'agent-one', '123-3-unknown.jpg'), 'utf8')).toBe('jpg')
  })

  it('rejects oversized images before writing files', () => {
    const config = testConfig()

    expect(() => promptWithSavedImages('agent-1', 'look', [{
      name: 'too-big.png',
      mimeType: 'image/png',
      data: Buffer.alloc((5 * 1024 * 1024) + 1).toString('base64'),
    }], {
      config,
      now: () => 123,
    })).toThrow('Image "too-big.png" is larger than 5MB')
    expect(existsSync(join(config.attachmentsDir, 'agent-1', '123-1-too-big.png'))).toBe(false)
  })

  it('surfaces filename collisions as write failures', () => {
    const config = testConfig()
    const existingPath = join(config.attachmentsDir, 'agent-1', '123-1-same.png')

    promptWithSavedImages('agent-1', 'look', [{
      name: 'same.png',
      mimeType: 'image/png',
      data: Buffer.from('first').toString('base64'),
    }], {
      config,
      now: () => 123,
    })
    writeFileSync(existingPath, 'existing')

    expect(() => promptWithSavedImages('agent-1', 'look', [{
      name: 'same.png',
      mimeType: 'image/png',
      data: Buffer.from('second').toString('base64'),
    }], {
      config,
      now: () => 123,
    })).toThrow()
    expect(readFileSync(existingPath, 'utf8')).toBe('existing')
  })
})

function testConfig(): KiriConfig {
  const root = mkdtempSync(join(tmpdir(), 'kiri-runtime-attachments-'))
  return {
    hostMode: 'web',
    rootDir: root,
    homeDir: root,
    kiriHome: root,
    stateDir: root,
    dbPath: join(root, 'kiri.sqlite'),
    settingsPath: join(root, 'settings.json'),
    preferencesPath: join(root, 'preferences.json'),
    piSessionsDir: join(root, 'pi-sessions'),
    runtimeSessionsDir: join(root, 'runtime-sessions'),
    attachmentsDir: join(root, 'attachments'),
    logsDir: join(root, 'logs'),
    defaultProjectCwd: root,
  }
}
