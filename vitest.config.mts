import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve(import.meta.dirname, 'src/shared') } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Node 22.x 的早期版本仍需要为 node:sqlite 打开实验开关。
    execArgv: ['--experimental-sqlite', '--no-warnings']
  }
})
