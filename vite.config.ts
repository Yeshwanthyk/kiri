import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { defineConfig } from 'vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 3090,
    strictPort: true,
    allowedHosts: ['.ts.net'],
  },
  resolve: {
    tsconfigPaths: true,
    alias: {
      // The published package's `main` points to a file that is not shipped;
      // only the ESM build exists. SSR/node-style resolution needs this alias.
      '@xterm/addon-ligatures': '@xterm/addon-ligatures/lib/addon-ligatures.mjs',
    },
  },
  ssr: {
    // UMD/CJS bundles that the dev SSR module runner cannot inline
    // ("exports is not defined"); load them through node instead.
    external: ['@xterm/headless', '@xterm/addon-serialize', '@xterm/addon-unicode11'],
  },
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
})
