import fs from 'fs-extra'

await fs.rm('dist', {
  force: true,
  recursive: true,
})
const buildResult = await Bun.build({
  entrypoints: ['src/main.ts'],
  format: 'esm',
  outdir: 'dist',
  packages: 'external',
  target: 'node',
})
if (!buildResult.success) {
  throw new AggregateError(buildResult.logs, 'Failed to build JavaScript output.')
}
await Bun.$`bunx tsc -p tsconfig.build.json`
