import { mkdir, copyFile } from 'node:fs/promises'
import { build } from 'esbuild'

await mkdir('dist', { recursive: true })
await build({
  entryPoints: { app: 'app.ts', 'zip-worker': 'zip-worker.mjs', importer: 'importer.mjs' },
  bundle: true,
  splitting: true,
  format: 'esm',
  target: ['es2022', 'safari17'],
  outdir: 'dist',
})
await Promise.all(['index.html', 'style.css'].map((file) => copyFile(file, `dist/${file}`)))
