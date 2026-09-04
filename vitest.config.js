import { defineConfig } from 'vitest/config';
import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.js'],
          exclude: ['src/**/*.integration.test.js'],
          environment: 'node',
        },
      },
      defineWorkersProject({
        test: {
          name: 'integration',
          include: ['src/**/*.integration.test.js'],
          poolOptions: {
            workers: {
              singleWorker: true,
              isolatedStorage: false,
              miniflare: {
                compatibilityDate: '2025-02-20',
                r2Buckets: ['MD_FILES'],
                kvNamespaces: ['HISTORY'],
                bindings: {
                  ACCESS_AUD: 'test-aud',
                  ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com',
                  LOG_LEVEL: 'error',
                },
              },
            },
          },
        },
      }),
    ],
  },
});
