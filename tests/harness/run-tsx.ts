import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process'

type RunJsonOptions = Omit<ExecFileSyncOptionsWithStringEncoding, 'encoding'>

export function runPnpmJson<T>(
  args: readonly string[],
  parse: (value: unknown) => T,
  options: RunJsonOptions = {},
): T {
  const output = execFileSync('pnpm', [...args], {
    cwd: process.cwd(),
    ...options,
    encoding: 'utf8',
  })
  return parse(JSON.parse(output))
}

export function runTsxJson<T>(
  script: string,
  parse: (value: unknown) => T,
  options: RunJsonOptions = {},
): T {
  return runTsxJsonWithArgs(script, [], parse, options)
}

export function runTsxJsonWithArgs<T>(
  script: string,
  args: readonly string[],
  parse: (value: unknown) => T,
  options: RunJsonOptions = {},
): T {
  return runPnpmJson(['exec', 'tsx', script, ...args], parse, options)
}
