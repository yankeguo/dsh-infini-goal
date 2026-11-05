import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.spec.ts', 'packages/*/tests/**/*.spec.tsx'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@yankeguo/dsh-infini-goal-protocol/client': new URL('./packages/protocol/src/client.ts', import.meta.url).pathname,
      '@yankeguo/dsh-infini-goal-protocol': new URL('./packages/protocol/src/index.ts', import.meta.url).pathname,
      '@yankeguo/dsh-infini-goal': new URL('./packages/infini-goal/src/index.ts', import.meta.url).pathname,
    },
  },
})
