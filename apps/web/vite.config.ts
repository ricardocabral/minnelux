import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => ({
  base: './',
  build: { outDir: mode === 'test' ? 'dist-test' : 'dist' },
  plugins: mode === 'test' ? [{
    name: 'minnelux-browser-fixture',
    async configurePreviewServer(server) {
      const { fixtureEndpoint } = await import('./src/test-fixtures/endpoint.ts')
      server.middlewares.use(await fixtureEndpoint())
    },
  }] : [],
}))
