import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => ({
  base: './',
  build: { outDir: mode === 'test' ? 'dist-test' : mode === 'session-test' ? 'dist-session-test' : 'dist' },
  ...(mode === 'session-test' && { define: { 'import.meta.env.VITE_DURABLE_GCS_SESSION': '"1"' } }),
  plugins: mode === 'test' ? [{
    name: 'minnelux-browser-fixture',
    async configurePreviewServer(server) {
      const { fixtureEndpoint } = await import('./src/test-fixtures/endpoint.ts')
      server.middlewares.use(await fixtureEndpoint())
    },
  }] : [],
}))
