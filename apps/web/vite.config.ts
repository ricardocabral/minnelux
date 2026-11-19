import { createRequire } from 'node:module'
import { defineConfig } from 'vite'

const require = createRequire(import.meta.url)

export default defineConfig(({ mode }) => ({
  base: './',
  worker: { format: 'es' },
  optimizeDeps: {
    // Avoid reloading the dev app when the first authorized worker loads the SDK.
    include: ['@aws-sdk/client-cognito-identity', '@aws-sdk/client-s3'],
  },
  resolve: {
    alias: [{
      // The SDK browser entry uses DOMParser, which is unavailable in workers.
      find: /^@aws-sdk\/xml-builder$/,
      replacement: require.resolve('@aws-sdk/xml-builder'),
    }],
  },
  build: { outDir: mode === 'test' ? 'dist-test' : 'dist' },
  plugins: mode === 'test' ? [{
    name: 'minnelux-browser-fixture',
    async configurePreviewServer(server) {
      const { fixtureEndpoint } = await import('./src/test-fixtures/endpoint.ts')
      server.middlewares.use(await fixtureEndpoint())
    },
  }] : [],
}))
