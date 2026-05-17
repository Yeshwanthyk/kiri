#!/usr/bin/env tsx

import { readFileSync } from 'node:fs'
import { Args, Command, Options } from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Console, Effect, Layer, Option } from 'effect'
import { KiriControl } from '~/server/kiri-control'
import { runKiriMcpServer } from '~/server/kiri-mcp'
import { runKiriOperation } from '~/server/kiri-router'

const version = '0.1.0'

const fileOption = Options.text('file').pipe(
  Options.withDescription('Read operation request JSON from file'),
  Options.optional,
)
const requestArg = Args.text({ name: 'request' }).pipe(
  Args.withDescription('Operation request JSON. If omitted, stdin is read.'),
  Args.optional,
)

const callCommand = Command.make(
  'call',
  { file: fileOption, request: requestArg },
  ({ file, request }) =>
    Effect.gen(function* () {
      const control = yield* KiriControl
      const input = parseRequest(readRequest(optionValue(file), optionValue(request)))
      if (!input.ok) {
        yield* Console.log(globalThis.JSON.stringify(input.response))
        return
      }
      const response = yield* Effect.promise(() => runKiriOperation(control, input.value))
      yield* Console.log(globalThis.JSON.stringify(response))
    }),
).pipe(Command.withDescription('Run one JSON Kiri operation'))

const mcpCommand = Command.make('mcp', {}, () =>
  Effect.gen(function* () {
    const control = yield* KiriControl
    yield* Effect.promise(() => runKiriMcpServer(control))
  }),
).pipe(Command.withDescription('Run the Kiri MCP server over stdio'))

export const kirictlCommand = Command.make('kirictl', {}).pipe(
  Command.withDescription('Agent-first JSON control surface for Kiri'),
  Command.withSubcommands([
    callCommand,
    mcpCommand,
  ]),
)

const cli = Command.run(kirictlCommand, {
  name: 'kirictl',
  version,
})

const MainLayer = Layer.merge(KiriControl.layer, NodeContext.layer)

cli(process.argv).pipe(
  Effect.provide(MainLayer),
  NodeRuntime.runMain,
)

function optionValue<A>(value: Option.Option<A>): A | undefined {
  return Option.getOrUndefined(value)
}

function readRequest(file: string | undefined, request: string | undefined) {
  if (file) return readFileSync(file, 'utf8')
  if (request) return request
  return readFileSync(0, 'utf8')
}

function parseRequest(input: string) {
  try {
    return { ok: true as const, value: globalThis.JSON.parse(input) as unknown }
  } catch (error) {
    return {
      ok: false as const,
      response: {
        ok: false,
        operation: 'operations.list',
        error: {
          code: 'INVALID_JSON',
          message: error instanceof Error ? error.message : 'Invalid JSON',
        },
      },
    }
  }
}
