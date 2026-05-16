import type { RuntimeKind } from '../../src/lib/contracts'
import { sessionRuntimeOrder, runtimeCopy } from '../../src/components/kiri-board/board-types'
import { scratchpadRuntimeOrder } from '../../src/components/kiri-board/scratchpad'
import { runtimeAdapters } from '../../src/server/provider-runtime'

type MissingRuntime<T extends readonly RuntimeKind[]> = Exclude<RuntimeKind, T[number]>

const sessionRuntimeOrderCoversAll: Record<MissingRuntime<typeof sessionRuntimeOrder>, never> = {}
const scratchpadRuntimeOrderCoversAll: Record<MissingRuntime<typeof scratchpadRuntimeOrder>, never> = {}
const runtimeCopyCoversAll: Record<RuntimeKind, unknown> = runtimeCopy
const providerAdaptersCoverAll: Record<RuntimeKind, unknown> = runtimeAdapters
const dbRuntimeCheckMigrationCoversAll = {
  pi: true,
  codex: true,
  claude: true,
} satisfies Record<RuntimeKind, true>

void sessionRuntimeOrderCoversAll
void scratchpadRuntimeOrderCoversAll
void runtimeCopyCoversAll
void providerAdaptersCoverAll
void dbRuntimeCheckMigrationCoversAll
