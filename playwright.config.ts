import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 1440, height: 900 },
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'npm run dev -- --port 5173 --strictPort',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'npm run server',
      url: 'http://127.0.0.1:8787/api/health',
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'npm run dev -- --port 5174 --strictPort',
      url: 'http://127.0.0.1:5174',
      env: { VITE_BRANCHLIGHT_API_URL: 'https://api.example.test' },
      reuseExistingServer: false,
    },
  ],
});
