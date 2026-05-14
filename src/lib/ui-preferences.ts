import { z } from 'zod'
import {
  defaultThemeSelection,
  kiriThemeNames,
  type ThemeSelection,
} from '~/theme/kiri-themes'

export const keymapActions = [
  'projectPrev',
  'projectNext',
  'agentPrev',
  'agentNext',
  'startSession',
  'deleteSession',
  'focusChat',
  'openDiffs',
  'openTerminal',
  'openScratchpad',
] as const

export type KeymapAction = (typeof keymapActions)[number]
export type KeymapSettings = Record<KeymapAction, string>

export const keyOptions = [
  'h',
  'j',
  'k',
  'l',
  'n',
  'x',
  'c',
  'd',
  't',
  's',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
] as const

export const defaultKeymap: KeymapSettings = {
  projectPrev: 'k',
  projectNext: 'j',
  agentPrev: 'h',
  agentNext: 'l',
  startSession: 'n',
  deleteSession: 'x',
  focusChat: 'c',
  openDiffs: 'd',
  openTerminal: 't',
  openScratchpad: 's',
}

export const chatFontSizeOptions = ['compact', 'comfortable', 'large', 'xlarge'] as const
export type ChatFontSize = (typeof chatFontSizeOptions)[number]

export const monoFontOptions = [
  'jetbrains',
  'fira',
  'plex',
  'proto',
  'berkeley',
  'blex',
  'commit',
  'dank',
  'operator',
  'system',
] as const
export type MonoFont = (typeof monoFontOptions)[number]

export type ChatTypographySettings = {
  fontSize: ChatFontSize
  monoFont: MonoFont
}

export const chatFontSizes: Record<ChatFontSize, { label: string; size: string; lineHeight: string }> = {
  compact: { label: 'Compact · 13px', size: '13px', lineHeight: '1.5' },
  comfortable: { label: 'Comfortable · 14px', size: '14px', lineHeight: '1.58' },
  large: { label: 'Large · 16px', size: '16px', lineHeight: '1.62' },
  xlarge: { label: 'Extra large · 18px', size: '18px', lineHeight: '1.66' },
}

export const monoFonts: Record<MonoFont, { label: string; stack: string }> = {
  jetbrains: {
    label: 'JetBrains Mono',
    stack: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  fira: {
    label: 'Fira Code',
    stack: '"Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  plex: {
    label: 'IBM Plex Mono',
    stack: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  proto: {
    label: '0xProto Nerd Font',
    stack: '"0xProto Nerd Font Mono", "0xProto Nerd Font", ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  berkeley: {
    label: 'BerkeleyMono Nerd Font',
    stack: '"BerkeleyMono Nerd Font", ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  blex: {
    label: 'BlexMono Nerd Font',
    stack: '"BlexMono Nerd Font Mono", "BlexMono Nerd Font", ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  commit: {
    label: 'CommitMono Nerd Font',
    stack: '"CommitMono Nerd Font Mono", "CommitMono Nerd Font", ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  dank: {
    label: 'DankMono Nerd Font',
    stack: '"DankMono Nerd Font Mono", "DankMono Nerd Font", ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  operator: {
    label: 'Operator Mono Lig',
    stack: '"OperatorMonoLig Nerd Font Mono", "Operator Mono Lig Book", "Operator Mono Lig Light", ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  system: {
    label: 'System Mono',
    stack: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  },
}

export const defaultChatTypography: ChatTypographySettings = {
  fontSize: 'comfortable',
  monoFont: 'jetbrains',
}

export const themeSelectionSchema = z.object({
  name: z.enum(kiriThemeNames),
  mode: z.enum(['light', 'dark']),
}) satisfies z.ZodType<ThemeSelection>

const keyBindingSchema = z.string().refine(
  (value) => (keyOptions as readonly string[]).includes(value),
  'Unsupported key binding',
)

export const keymapSettingsSchema = z.object({
  projectPrev: keyBindingSchema,
  projectNext: keyBindingSchema,
  agentPrev: keyBindingSchema,
  agentNext: keyBindingSchema,
  startSession: keyBindingSchema,
  deleteSession: keyBindingSchema,
  focusChat: keyBindingSchema,
  openDiffs: keyBindingSchema,
  openTerminal: keyBindingSchema,
  openScratchpad: keyBindingSchema,
}).superRefine((value, context) => {
  const seen = new Map<string, KeymapAction>()
  for (const action of keymapActions) {
    const key = value[action]
    const existing = seen.get(key)
    if (!existing) {
      seen.set(key, action)
      continue
    }
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [action],
      message: `Key ${key} is already bound to ${existing}`,
    })
  }
}) satisfies z.ZodType<KeymapSettings>

export const chatTypographySchema = z.object({
  fontSize: z.enum(chatFontSizeOptions),
  monoFont: z.enum(monoFontOptions),
}) satisfies z.ZodType<ChatTypographySettings>

export const agentByProjectSchema = z.record(z.string(), z.string())

export const uiPreferencesSchema = z.object({
  theme: themeSelectionSchema.default(defaultThemeSelection),
  keymap: keymapSettingsSchema.default(defaultKeymap),
  chatTypography: chatTypographySchema.default(defaultChatTypography),
  agentByProject: agentByProjectSchema.default({}),
})

export type UiPreferences = z.infer<typeof uiPreferencesSchema>

export const defaultUiPreferences: UiPreferences = uiPreferencesSchema.parse({})

export function normalizeChatTypography(value: Record<string, unknown>): ChatTypographySettings {
  const fontSize = typeof value.fontSize === 'string' && value.fontSize in chatFontSizes
    ? value.fontSize as ChatFontSize
    : defaultChatTypography.fontSize
  const monoFont = typeof value.monoFont === 'string' && value.monoFont in monoFonts
    ? value.monoFont as MonoFont
    : defaultChatTypography.monoFont
  return { fontSize, monoFont }
}
