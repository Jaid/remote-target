# remote-target

Run small JavaScript or TypeScript snippets and regular commands on another machine over SSH.

It is designed for modern runtimes and modern hosts:

- caller runtime: latest Bun
- remote runtimes: latest Bun, Node or Deno
- remote operating systems: Windows 11, Debian-like Linux, Arch Linux and NixOS

## Features

- accepts either a raw function or a script string
- normalizes TypeScript and TSX/JSX with SWC before execution
- supports `export default`, named exports and top-level `return`
- preserves structured values like `Map`s and `Set`s across exports and return values
- injects globals through `serialize-javascript`, including self-contained functions and values like `Map`, `Set`, `Date`, `URL`, `RegExp` and `BigInt`
- discovers the remote OS, login shell and available runtimes
- executes plain argv-style commands without shell quoting surprises
- supports globals injection for snippets
- includes a `local` pseudo-target for tests and local tooling

## Install

```sh
bun add remote-target
```

## Usage

### Run a function remotely

```ts
import RemoteTarget from 'remote-target'

const remoteTarget = new RemoteTarget('vps')

const result = await remoteTarget.run(async () => {
	const fs = await import('node:fs/promises')
	return await fs.readdir('/')
})
```

### Run a TypeScript string remotely

```ts
import RemoteTarget from 'remote-target'

const remoteTarget = new RemoteTarget({
	host: 'nas',
	runtimeCandidates: ['bun', 'node'],
})

const result = await remoteTarget.run(`
	import os from 'node:os'
	export const platform = os.platform()
	export const arch = os.arch()
`)
```

### Execute a plain command

```ts
import RemoteTarget from 'remote-target'

const remoteTarget = new RemoteTarget('pi')

const result = await remoteTarget.exec(['fastfetch', '--json'])
```

### Resolve runtime info

```ts
import RemoteTarget from 'remote-target'

const remoteTarget = new RemoteTarget('tower')

await remoteTarget.init()
const runtime = remoteTarget.getRuntime()
```

### Inject globals

```ts
import RemoteTarget from 'remote-target'

const remoteTarget = new RemoteTarget('cloud', {
	globals: {
		password: 'correct horse battery staple',
	},
})
```

### Local test mode

```ts
import RemoteTarget from 'remote-target'

const result = await RemoteTarget.run('local', () => ({
	runtime: typeof Bun,
	user: process.env.USERNAME,
}))
```

## Notes

- `run()` throws when the remote snippet fails.
- `exec()` does not throw on non-zero exit codes. It returns the structured invocation result.
- shell builtins still require an explicit shell invocation, for example `['pwsh', '-Command', 'echo hello']`.
- JSX is normalized to a tiny built-in object-based runtime so simple TSX works without React.
- exported and returned values preserve common structured types like `Map`, `Set`, `Date`, `URL`, `RegExp` and typed arrays.
- globals are embedded as JavaScript source, not as installed dependencies – imported module namespace objects and closure-dependent functions are still not portable. Import packages inside the remote script when needed.
