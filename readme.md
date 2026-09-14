# remote-target

Run small JavaScript or TypeScript snippets and regular commands locally, over SSH or inside Docker containers.

It is designed for modern runtimes and modern hosts:

- caller runtime: Bun 1.3.14 or newer, or Node 24.11 or newer
- remote runtimes: latest Bun, Node or Deno
- remote operating systems: Windows 11 and modern Linux distributions

## Features

- accepts either a raw function or a script string
- normalizes TypeScript and TSX/JSX with Babel before execution
- supports `export default`, named exports and top-level `return`
- preserves structured values like `Map`s and `Set`s across exports and return values
- injects globals through `serialize-javascript`, including self-contained functions and values like `Map`, `Set`, `Date`, `URL`, `RegExp` and `BigInt`
- discovers the remote OS, login shell and available runtimes, with optional caller assumptions to skip known work
- executes plain argv-style commands without shell quoting surprises
- includes a `local` pseudo-target for tests and local tooling
- targets Docker containers by ID or name through the caller's Docker CLI configuration
- accepts caller-supplied transports and supports subclassing the built-in local, SSH and container transports
- exposes stdout/stderr chunks through transport events and per-invocation callbacks

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

`run()` accepts `maxOutputBytes`, `maxResultBytes`, `timeoutMs` and `signal` as its second argument. Its stdin carries the generated module, so arbitrary snippet stdin is not available.

### Resolve runtime info

```ts
import RemoteTarget from 'remote-target'

const remoteTarget = new RemoteTarget('tower')

await remoteTarget.init()
const runtime = remoteTarget.getRuntime()
```

### Target assumptions

Use `assumptions` when the caller already knows target characteristics. A complete set skips discovery entirely:

```ts
import RemoteTarget, {ContainerTransport} from 'remote-target'

const target = new RemoteTarget('mage-session', {
  assumptions: {
    os: {name: 'linux', distribution: 'unknown'},
    runtimes: [{name: 'bun', file: 'bun'}],
    shell: {name: 'unknown'},
  },
  runtimeCandidates: ['bun'],
  transport: new ContainerTransport(containerId),
})

await target.init() // No discovery command is executed.
```

Assumptions are authoritative and are merged over discovered values. The three independently assumable sections are `os`, `runtimes` and `shell`. If any required section is omitted, initialization discovers the missing information. Supplying `runtimes` also skips runtime probing: when other metadata is still missing, one of the assumed runtimes is used as the bootstrap runtime. An explicit `runtimes: []` means the target is assumed to have no compatible runtime. Likewise, an explicit `os` or `shell` with an `unknown` value suppresses discovery for that section while honestly preserving that the finer detail is unknown.

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

## Container transports

`ContainerTransport` executes in an existing, running Docker container by ID or name. It uses the local Docker CLI and inherits its current context, `DOCKER_HOST`, SSH configuration and TLS configuration. It does not create, start, stop or remove containers.

```ts
import RemoteTarget, {ContainerTransport} from 'remote-target'

const transport = new ContainerTransport(containerId, {user: 'agent'})
const target = new RemoteTarget('mage-session', {
  assumptions: {
    os: {name: 'linux', distribution: 'unknown'},
    runtimes: [{name: 'bun', file: 'bun'}],
    shell: {name: 'unknown'},
  },
  transport,
  runtimeCandidates: ['bun'],
})

const result = await target.run('return process.cwd()')
```

The constructor also accepts an options object:

```ts
const transport = new ContainerTransport({container: containerId, user: '1000:1000'})
```

The exported `ContainerTransportOptions` type describes these options:

| Option | Meaning |
| --- | --- |
| `container` | ID or name of the running container. |
| `user` | Optional container username or UID, with an optional `:group` or `:gid`. Otherwise Docker uses the container's configured user. |
| `dockerCommand` | Local executable path or argv prefix. Defaults to `'docker'`; for example `['docker', '--context', 'nas']` or `['docker', '--host', 'ssh://nas']`. |
| `shellCommand` | Interpreter prefix for `runShellCommand()` only. Defaults to `['sh', '-c']` **inside the container**, independently of the caller's OS. Windows containers can use `['pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command']`. |

`runShellNeutralCommand()` passes literal argv to `docker exec`; it never inserts `sh -c` or allocates a TTY. Supplying stdin, including an empty string, adds `--interactive`. Generated runtime programs, result-frame filtering, output limits, chunk events and invocation callbacks therefore use the same machinery as the other built-in transports.

For Mage-style custom runners, the direct interface remains unchanged:

```ts
const invocation = await target.transport.runShellNeutralCommand([target.getRuntime().file, '-'], {
  stdin: 'process.stdout.write(Buffer.from("hello").toString("base64"))',
  timeoutMs: 10_000,
})
```

Per-command working directories and environment variables remain the custom runner's responsibility; the transport does not add a second cwd/env policy. Shell-neutral execution and runtime discovery do not require a shell or SSH server inside the container. Only an explicit `runShellCommand()` needs the configured interpreter.

Subclass `ContainerTransport` and override the protected `getDockerBaseCommand()` or `runContainer(command, options)` hooks when needed. A replacement execution path must retain the framing and chunk-callback contract described below.

**Cancellation scope:** timeouts and abort signals terminate the local Docker CLI through the existing bounded process cleanup. They do not guarantee termination of the process or its descendants inside the container. The caller still owns container lifecycle and any stronger in-container cancellation policy; this transport never kills the entire container as a substitute.

Run `bun run test:container` for the focused unit and real-container suites. Set `DOCKER_HOST=ssh://nas` or choose a Docker context to test a remote daemon. `REMOTE_TARGET_SKIP_INTEGRATION=1` skips real-container tests without probing Docker, and `REMOTE_TARGET_CONTAINER_IMAGE` overrides the pinned Bun test image. The suite creates no SSH server or published container ports and removes only its own uniquely named container.

## Custom transports and chunk events

Pass a `TargetTransport` instance through `transport` to replace the built-in local/OpenSSH transport. The instance can inherit directly from the abstract base or from `LocalTargetTransport`, `SshTargetTransport` or `ContainerTransport`.

```ts
import RemoteTarget, {LocalTargetTransport} from 'remote-target'

class InstrumentedLocalTransport extends LocalTargetTransport {
  // Override built-in behavior when needed.
}

const transport = new InstrumentedLocalTransport
const target = new RemoteTarget('custom-target', {
  transport,
  runtimeCandidates: ['bun'],
})
```

Fully independent transports implement `runShellCommand()` and `runShellNeutralCommand()`. Custom implementations can use the protected `createChunkEmitter(command, options)` helper so transport-level listeners and per-call callbacks receive the same chunks.

For `RemoteTarget.run()` and runtime-backed `exec()`, a fully independent transport must also honor `options.frame`: detect and remove the marked result frame from stdout, call its `onFrame`/`onError` callbacks and keep those frame bytes out of returned/user-visible stdout. The built-in transports already do this. A subclass that replaces the built-in low-level execution path must preserve the same contract.

```ts
import type {InvocationResult, TransportCommandOptions} from 'remote-target'
import {TargetTransport} from 'remote-target'

class MyTransport extends TargetTransport {
  async runShellCommand(command: string, options: TransportCommandOptions = {}): Promise<InvocationResult> {
    const chunks = this.createChunkEmitter(command, options)
    // Feed actual incoming bytes to chunks.stdout(...) / chunks.stderr(...).
    throw new Error('implementation omitted')
  }

  async runShellNeutralCommand(command: Array<string>, options: TransportCommandOptions = {}): Promise<InvocationResult> {
    const chunks = this.createChunkEmitter(command, options)
    throw new Error('implementation omitted')
  }
}
```

Transport instances expose `stdout` and `stderr` events. Each event includes the incoming `Uint8Array` chunk, a stable `invocationId` for that transport call and the logical command associated with it. `on()` returns an unsubscribe function; `off()` removes a listener explicitly.

```ts
const unsubscribe = target.transport.on('stdout', event => {
  console.log(event.invocationId, event.command, Buffer.from(event.chunk).toString())
})

await target.exec(['tool', '--verbose'])
unsubscribe()
```

For one invocation, use `onStdoutChunk` and `onStderrChunk` instead:

```ts
await target.exec(['tool'], {
  onStdoutChunk: chunk => process.stdout.write(chunk),
  onStderrChunk: chunk => process.stderr.write(chunk),
})
```

Chunk boundaries are transport/runtime boundaries and are not stable message boundaries. Callbacks receive only user-visible captured output: internal result frames are excluded, and an output limit can truncate the final delivered chunk. Runtime-backed `exec()` forwards child stdout/stderr while the command is running, then returns the same captured output in its final result.

## SSH configuration

The transport detects the shell that actually interprets SSH commands. Supported modes are POSIX-compatible shells, fish, PowerShell 7.3 or newer, and `cmd.exe` with `pwsh.exe` available on the remote PATH. An explicit `sshShell` skips automatic shell probing; it must match the shell configured in the SSH server, not merely a shell installed on the target.

```ts
const target = new RemoteTarget('container', {
  runtimeCandidates: ['bun'],
  sshShell: 'posix',
  keyFile: 'C:/keys/container',
  knownHostsFile: 'C:/keys/container_known_hosts',
  strictHostKeyChecking: 'yes',
  initializationTimeoutMs: 30_000,
})
```

Command encoding uses `escapers`: custom `createEscaper` adapters for POSIX and fish syntax, and the built-in PowerShell escaper for PowerShell literals. Runtime-backed execution sends the actual command argv inside the generated program. The no-runtime fallback uses the same shell-specific encoder. Arguments containing NUL are rejected; stdin text can contain NUL.

`knownHostsFile` also disables system-wide host-key files for that invocation. `sshConfigFile` selects an SSH configuration file, which is useful for isolated tests. `sshOptions` accepts additional trusted OpenSSH `-o` settings. These advanced options appear before the defaults and can override them, so they should come from application configuration rather than untrusted command input. Key paths and known-hosts paths can contain spaces.

## Output, errors and deadlines

`maxOutputBytes` limits combined user stdout and stderr bytes. Structured result frames do not count against it, so `run('return 42', {maxOutputBytes: 0})` succeeds. Diagnostic messages generated by remote-target are kept separately and can make returned stderr exceed the user-output cap.

`maxResultBytes` bounds the JSON result frame independently and defaults to `16_000_000`. This includes encoded exports, return values and, for runtime-backed `exec()`, the captured command result. A result that exceeds this budget fails explicitly rather than being silently truncated. This bounds received protocol data, not the remote program’s own allocations or process memory.

```ts
import RemoteTarget, {RemoteTargetError} from 'remote-target'

const target = new RemoteTarget('nas')

try {
  await target.run('console.log("started"); throw new Error("boom")', {
    maxOutputBytes: 100_000,
    maxResultBytes: 16_000_000,
    timeoutMs: 10_000,
  })
} catch (error) {
  if (error instanceof RemoteTargetError) {
    console.error(error.result.exitCode, error.result.stderr, error.result.stdout)
    console.error(error.cause)
  } else {
    throw error
  }
}
```

Invocation results retain `duration`, `exitCode`, `stdout`, `stderr` and `system.pid`. Process-control failures additionally expose `failure`, such as `timeout`, `output-limit`, `spawn`, `stdin`, `stream` or `protocol`, and a native `errorCode` when available. Error frames are decoded even when the process failed, preserving useful remote causes alongside partial output and transport diagnostics.

A call’s `timeoutMs` covers waiting for initialization, normalization and execution. Already-aborted signals are rejected before discovery starts. Initialization is shared and has its own `initializationTimeoutMs` bound, defaulting to `30_000`; canceling one invocation stops that waiter without canceling initialization needed by another. Failed initialization can be retried. `init({signal, timeoutMs})` supports the same independent waiting behavior. Synchronous transformation work cannot be preempted inside the caller’s event loop, but an expired deadline prevents a subsequent execution process from starting.

## Direct transport integration

The `target.transport.runShellNeutralCommand(argv, options)` interface remains available for custom runners such as Mage, including when the target was constructed with a caller-supplied transport. Without internal framing options, stdout is returned unchanged: remote-target does not interpret an application’s JSON, base64 output or marker-like text.

```ts
const target = new RemoteTarget('container', {runtimeCandidates: ['bun']})
await target.init()
const runtime = target.getRuntime()
// This example selects Bun and sends a self-contained program through stdin.
const invocation = await target.transport.runShellNeutralCommand([runtime.file, '-'], {
  stdin: 'process.stdout.write(Buffer.from("hello").toString("base64"))',
  timeoutMs: 10_000,
})
```

Select `runtimeCandidates: ['bun']` for the command form above. Node and Deno require their respective stdin-module arguments. Direct transport callers own their application protocol, execution environment and per-stream truncation policy; those remain separate from remote-target’s higher-level `run()` and `exec()` contracts.

## Notes

- `run()` throws `RemoteTargetError` for remote execution and protocol failures, including a nonzero process exit after a successful return. Invalid caller input or normalization can throw before a process starts.
- `exec()` returns a structured invocation result for nonzero command exits, command-spawn failures and invocation timeouts. Transport, discovery or malformed-result failures can reject. Cancellation through an `AbortSignal` rejects with the original signal reason.
- shell builtins still require an explicit shell invocation, for example `['pwsh', '-Command', 'echo hello']`.
- JSX is normalized to a tiny built-in object-based runtime so simple TSX works without React.
- exported and returned values preserve `Map`, `Set`, `Date`, `URL`, `RegExp`, `DataView`, `ArrayBuffer`, `Buffer` and supported typed arrays. Negative zero and sparse array holes survive the JSON wire boundary. `Float16Array` requires support in the caller; an unsupported caller receives an explicit error. Functions and cycles become descriptive strings, and shared-reference identity is not preserved.
- globals are embedded as JavaScript source, not as installed dependencies. Imported module namespace objects and closure-dependent functions are not portable. Built-in `node:` imports work inside snippets; installed-package and relative-file resolution is runtime-dependent. Node snippets currently use a `data:` module and do not provide a filesystem resolution base.
- raw function input is serialized with `Function.prototype.toString()` and must be self-contained. Script strings support import syntax but do not capture caller closures either. Pass caller values through explicit `globals` injection.
- SSH uses batch mode, a 10-second connection timeout and `StrictHostKeyChecking=accept-new` by default. Pre-provision a known-hosts file and set `strictHostKeyChecking: 'yes'` when first-use trust is unsuitable.
- timeout and cancellation cleanup first request termination, then escalate after 500 ms and bound stream cleanup. This can add up to roughly one second after a deadline. Killing an SSH client does not guarantee remote process-tree cleanup; commands that survive connection teardown require target-specific cleanup.
- the SSH matrix integration tests require Docker and SSH. Test keys are generated with `make-ssh-keys`. `REMOTE_TARGET_SKIP_INTEGRATION=1` skips the matrix before probing those tools. The matrix isolates SSH configuration and host-key storage, bounds child processes and removes only its own containers, image tags and temporary files.
