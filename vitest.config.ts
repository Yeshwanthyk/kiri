import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '~': new URL('./src', import.meta.url).pathname,
      // The published package's `main` points to a file that is not shipped;
      // only the ESM build exists. Node-style resolution needs this alias.
      '@xterm/addon-ligatures': '@xterm/addon-ligatures/lib/addon-ligatures.mjs',
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
