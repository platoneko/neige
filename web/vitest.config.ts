import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Test config for the shared @neige/shared package (and any future web tests).
// We host the runner in web/ to avoid adding a package.json to the shared
// source-only package — the existing symlink already gives shared access to
// web/node_modules.
export default defineConfig({
  plugins: [react()],
  // web/src files resolve web/tsconfig.json, a references-only stub with no
  // "jsx" setting, so esbuild would fall back to classic React.createElement.
  // Match tsconfig.app.json's react-jsx.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@neige/shared': path.resolve(__dirname, '../packages/neige-web-shared/src'),
      // Pin react and react-dom to web/node_modules for tests under
      // packages/. The shared package has a symlinked node_modules at
      // build time, but vitest resolves from each test file's directory
      // and won't find react that way.
      react: path.resolve(__dirname, 'node_modules/react'),
      'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
    },
    dedupe: ['react', 'react-dom'],
  },
  test: {
    environment: 'happy-dom',
    root: path.resolve(__dirname, '..'),
    include: [
      'packages/neige-web-shared/src/**/*.test.{ts,tsx}',
      'web/src/**/*.test.{ts,tsx}',
    ],
    server: {
      deps: {
        inline: [/@neige\/shared/],
      },
    },
  },
  // Allow vitest to read from the entire workspace (defaults to a tighter
  // sandbox that breaks the cross-package layout).
  server: {
    fs: { strict: false },
  },
})
