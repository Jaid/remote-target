import * as path from 'forward-slash-path'
import fs from 'fs-extra'

const folder = path.resolve('temp/packageSmoke')
await fs.rm(folder, {
  force: true,
  recursive: true,
})
await fs.mkdir(folder, {recursive: true})
await Bun.$`bun pm pack --destination ${folder}`
const packageMetadata: unknown = await Bun.file('package.json').json()
if (!packageMetadata || typeof packageMetadata !== 'object' || !('version' in packageMetadata) || typeof packageMetadata.version !== 'string') {
  throw new TypeError('Expected package.json to contain a version.')
}
const tarball = path.join(folder, `remote-target-${packageMetadata.version}.tgz`)
await fs.writeFile(path.join(folder, 'package.json'), JSON.stringify({
  private: true,
  type: 'module',
}))
await Bun.$`bun add ${tarball}`.cwd(folder)
const smokeCode = `
import RemoteTarget from 'remote-target'
const result = await RemoteTarget.run('local', 'return 42', {runtimeCandidates: ['bun']})
if (result.returnValue !== 42) throw new Error('Unexpected package smoke-test result.')
`
await fs.writeFile(path.join(folder, 'smoke.mjs'), smokeCode)
await fs.writeFile(path.join(folder, 'smoke.ts'), smokeCode)
await Bun.$`bun smoke.mjs`.cwd(folder)
await Bun.$`node smoke.mjs`.cwd(folder)
await Bun.$`bunx tsc --ignoreConfig --noEmit --module nodenext --moduleResolution nodenext --target esnext smoke.ts`.cwd(folder)
