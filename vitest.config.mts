import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve(import.meta.dirname, 'src/shared') } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 本机 Node 22.11 的 node:sqlite 还需要实验开关；Electron 内置的 Node 24 不需要
    execArgv: ['--experimental-sqlite', '--no-warnings']
  }
})
