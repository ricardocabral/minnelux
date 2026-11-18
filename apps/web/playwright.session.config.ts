import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './session',
  testMatch: '**/*.spec.mjs',
  workers: 1,
})
