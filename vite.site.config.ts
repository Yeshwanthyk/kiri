import { defineConfig } from 'vite'
import viteReact from '@vitejs/plugin-react'

export default defineConfig({
  root: 'site',
  publicDir: '../public',
  build: {
    outDir: '../dist/site',
    emptyOutDir: true,
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [viteReact()],
})
