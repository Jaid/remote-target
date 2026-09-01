# remote-target

Run small JavaScript or TypeScript snippets and regular commands on another machine over SSH.

It is designed for modern runtimes and modern hosts:

- caller runtime: Bun 1.3.14 or newer, or Node 24 or newer
- remote runtimes: latest Bun, Node or Deno
- remote operating systems: Windows 11 and modern Linux distributions

## Features

- accepts either a raw function or a script string
- normalizes TypeScript and TSX/JSX with Babel before execution
- supports `export default`, named exports and top-level `return`
- preserves structured values like `Map`s and `Set`s across exports and return values
- injects globals through `serialize-javascript`, including self-contained functions and values like `Map`, `Set`, `Date`, `URL`, `RegExp` and `BigInt`
- discovers the remote OS, login shell and available runtimes
- executes plain argv-style commands without shell quoting surprises
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

Commands accept shared invocation controls:

```ts
const result = await remoteTarget.exec(['fastfetch', '--json'], {
	maxOutputBytes: 1_000_000,
	stdin: 'optional input',
	timeoutMs: 30_000,
})
```

`run()` accepts `maxOutputBytes`, `timeoutMs` and `signal` as its second argument. Its stdin carries the generated module, so arbitrary snippet stdin is not available.

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
- `exec()` returns a structured invocation result for non-zero exits and process-spawn failures. Cancellation through an `AbortSignal` rejects.
- shell builtins still require an explicit shell invocation, for example `['pwsh', '-Command', 'echo hello']`.
- JSX is normalized to a tiny built-in object-based runtime so simple TSX works without React.
- exported and returned values preserve common structured types like `Map`, `Set`, `Date`, `URL`, `RegExp`, `DataView`, `ArrayBuffer` and typed arrays.
- globals are embedded as JavaScript source, not as installed dependencies – imported module namespace objects and closure-dependent functions are still not portable. Import packages inside the remote script when needed.
- raw function input is serialized with `Function.prototype.toString()` and must therefore be self-contained. Prefer script strings for imports, closures or caller-specific syntax.
- SSH uses batch mode, a 10-second connection timeout and `StrictHostKeyChecking=accept-new`. Pre-provision `known_hosts` when first-use trust is unsuitable.
- output limits count stdout and stderr together. A timeout terminates the local process or SSH client; a remote process that ignores connection teardown may require target-specific cleanup.
- integration tests require Docker and SSH. Set `REMOTE_TARGET_SKIP_INTEGRATION=1` only when intentionally skipping them in a local environment.
