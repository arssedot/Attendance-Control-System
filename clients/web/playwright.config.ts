import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  workers: 1,
  timeout: 45_000,
  use: {
    baseURL: process.env.ATTENDANCE_QA_URL ?? 'https://localhost',
    ignoreHTTPSErrors: true,
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    trace: 'retain-on-failure',
  },
})
