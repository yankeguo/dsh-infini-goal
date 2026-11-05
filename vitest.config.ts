import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/** Resolve one workspace source file to an absolute path Vite can alias. */
const source = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url))

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.spec.ts', 'packages/*/tests/**/*.spec.tsx'],
    environment: 'node',
  },
  resolve: {
    alias: {
      // The subpath alias must precede its package alias: Vite applies the
      // first matching entry, and a checkout path with spaces or non-ASCII
      // characters must survive as a real path (URL.pathname would percent-encode it).
      '@yankeguo/dsh-infini-goal-protocol/client': source('./packages/protocol/src/client.ts'),
      '@yankeguo/dsh-infini-goal-protocol': source('./packages/protocol/src/index.ts'),
      '@yankeguo/dsh-infini-goal': source('./packages/infini-goal/src/index.ts'),
    },
  },
})
