import type { RuntimeKind } from '../../src/lib/contracts'
import { runtimeAdapters } from '../../src/server/provider-runtime'

const providerAdaptersCoverAll: Record<RuntimeKind, unknown> = runtimeAdapters
const dbRuntimeCheckMigrationCoversAll = {
  pi: true,
  codex: true,
  claude: true,
  opencode: true,
} satisfies Record<RuntimeKind, true>

void providerAdaptersCoverAll
void dbRuntimeCheckMigrationCoversAll
