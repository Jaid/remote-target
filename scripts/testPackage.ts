import {spawnSync} from 'node:child_process'
import {tmpdir} from 'node:os'

import * as path from 'forward-slash-path'
import fs from 'fs-extra'

import packageMetadata from '../package.json' with {type: 'json'}

const root = path.resolve(import.meta.dir, '..')
const built = path.join(root, 'dist', packageMetadata.name, 'production')
const run = (command: Array<string>, cwd: string, timeoutMs = 120_000) => {
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 4_000_000,
  })
  if (result.error || result.status !== 0) {
    throw new Error(`${command.join(' ')} failed.\n${result.stdout}\n${result.stderr}`, {cause: result.error})
  }
  console.log(`${command.join(' ')} passed.`)
}
const folder = path.enforceForwardSlashes(await fs.mkdtemp(path.join(tmpdir(), 'remote-target-package-')))
try {
  run(['bun', 'run', 'build'], root)
  run(['bun', 'pm', 'pack', '--destination', folder], built)
  const consumer = path.join(folder, 'consumer')
  const unrelated = path.join(folder, 'unrelated')
  await fs.mkdir(consumer)
  await fs.mkdir(unrelated)
  await fs.writeJson(path.join(consumer, 'package.json'), {
    private: true,
    type: 'module',
  })
  run(['bun', 'add', '--linker', 'isolated', path.join(folder, `${packageMetadata.name}-${packageMetadata.version}.tgz`)], consumer)
  const smoke = [
    "import assert from 'node:assert/strict'",
    "import RemoteTarget, {ContainerTransport, LocalTargetTransport, TargetTransport} from 'remote-target'",
    "const local = new RemoteTarget('local')",
    'const run = await local.run(\'import {Buffer} from "node:buffer"; return {buffer: Buffer.from("hello"), zero: -0, sparse: Array(2), map: new Map([[1, new Set([2])]])}\', {maxOutputBytes: 0})',
    'assert.equal(run.returnValue.buffer.toString(), "hello")',
    'assert(Object.is(run.returnValue.zero, -0))',
    'assert.equal(0 in run.returnValue.sparse, false)',
    'assert.deepEqual(run.returnValue.map, new Map([[1, new Set([2])]]))',
    'assert.equal(run.stdout, undefined)',
    'class CustomTransport extends LocalTargetTransport {}',
    'const transport = new CustomTransport()',
    'const loopback = new RemoteTarget("loopback", {transport, runtimeCandidates: ["bun"]})',
    'await loopback.init()',
    'const streamed = []',
    'const unsubscribe = transport.on("stdout", event => streamed.push(Buffer.from(event.chunk)))',
    'const exec = await loopback.exec([process.execPath, "--eval", "process.stdin.pipe(process.stdout)"], {stdin: "hello stdin", timeoutMs: 10000})',
    'unsubscribe()',
    'assert.equal(exec.exitCode, 0)',
    'assert.equal(exec.stdout, "hello stdin")',
    'assert.equal(Buffer.concat(streamed).toString(), "hello stdin")',
    'const dockerCommand = [process.execPath, "--eval", "process.stdout.write(JSON.stringify(42))", "--"]',
    'const container = new ContainerTransport("fixture", {dockerCommand})',
    'assert(container instanceof TargetTransport)',
    'for (const selected of [container]) {',
    '  const result = await selected.runShellNeutralCommand(["bun", "-"], {stdin: "program", timeoutMs: 10000})',
    '  assert.equal(result.exitCode, 0)',
    '  assert.equal(result.stdout, "42")',
    '}',
  ].join('\n')
  await fs.writeFile(path.join(consumer, 'smoke.mjs'), smoke)
  run(['bun', path.join(consumer, 'smoke.mjs')], unrelated)
  run(['node', path.join(consumer, 'smoke.mjs')], unrelated)
  const declarations = [
    "import type {ContainerTransportOptions, DiscoveryInfo, InvocationResult, RemoteTargetAssumptions, RuntimeInfo, TransportChunkEvent} from 'remote-target'",
    "import RemoteTarget, {ContainerTransport, LocalTargetTransport, RemoteTargetError, SshTargetTransport, TargetTransport} from 'remote-target'",
    'class CustomTransport extends LocalTargetTransport {}',
    'const transport: TargetTransport = new CustomTransport()',
    'const target = new RemoteTarget("local", {sshShell: "posix", initializationTimeoutMs: 30000, transport})',
    'await target.init({timeoutMs: 10000})',
    'const discovery: DiscoveryInfo = target.getDiscovery()',
    'const runtime: RuntimeInfo = target.getRuntime()',
    'const invocation: InvocationResult = await target.transport.runShellNeutralCommand([runtime.file, "-"], {stdin: "console.log(42)"})',
    'const unsubscribe = transport.on("stdout", (event: TransportChunkEvent) => void event.invocationId)',
    'unsubscribe()',
    'const sshClass: typeof SshTargetTransport = SshTargetTransport',
    'const error = new RemoteTargetError("failure", invocation)',
    'const containerOptions: ContainerTransportOptions = {container: "fixture", user: "1000:1000", dockerCommand: ["docker", "--context", "nas"]}',
    'const container: TargetTransport = new ContainerTransport(containerOptions)',
    'const assumptions: RemoteTargetAssumptions = {os: {name: "unknown"}, runtimes: [{file: "bun", name: "bun"}], shell: {name: "unknown"}}',
    'const assumed = new RemoteTarget("assumed", {assumptions, transport: container, runtimeCandidates: ["bun"]})',
    'void [discovery, runtime, invocation, error.result, sshClass, container, assumed]',
  ].join('\n')
  await fs.writeFile(path.join(consumer, 'smoke.ts'), declarations)
  run(['bun', path.join(root, 'node_modules/typescript/bin/tsc'), '--ignoreConfig', '--noEmit', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'esnext', path.join(consumer, 'smoke.ts')], unrelated)
} finally {
  await fs.rm(folder, {
    force: true,
    recursive: true,
  })
}
