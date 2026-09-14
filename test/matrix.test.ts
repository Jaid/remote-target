import type {LinuxDistribution, RuntimeName} from '#src/lib/remoteTarget/index.ts'

import {afterAll, beforeAll, describe, expect, test} from 'bun:test'

import * as path from 'forward-slash-path'
import fs from 'fs-extra'
import makeSshKeys from 'make-ssh-keys'
import {renderHandlebars} from 'zeug'

import {runProcess} from '#src/lib/remoteTarget/runProcess.ts'
import {SshTargetTransport} from '#src/lib/transport/SshTargetTransport.ts'
import RemoteTarget from '#src/main.ts'

type BaseCase = {
  baseImage: string
  baseImageVersion: string
  expectedDistribution: LinuxDistribution
  id: string
  kind: 'apt' | 'arch' | 'nix'
}

type RuntimeCase = {
  binarySourcePath: string
  builderImage: string
  id: RuntimeName
  version: string
}

type ScriptCase = {
  expected: {
    exports: Record<string, unknown>
    returnValue: unknown
  }
  id: string
  inputCode: string
}

type BaseContext = {
  authorizedKey: string
  folder: string
  privateKeyFile: string
}

type RuntimeContext = {
  baseContext: BaseContext
  containerId: string
  containerName: string
  discovery: ReturnType<RemoteTarget['getDiscovery']>
  dockerfileFile: string
  hostPort: number
  imageTag: string
  knownHostsFile: string
  remoteTarget: RemoteTarget
  runtimeInfo: ReturnType<RemoteTarget['getRuntime']>
  runtimeWorkFolder: string
  sshConfigFile: string
  sshHost: string
}

const dockerfileTemplate = await fs.readFile(path.join(import.meta.dir, 'lib/Dockerfile.hbs'), 'utf8')
const helloScript = await fs.readFile(path.join(import.meta.dir, 'fixture/script/hello.ts'), 'utf8')
const namedExportsScript = await fs.readFile(path.join(import.meta.dir, 'fixture/script/namedExports.ts'), 'utf8')
const baseCases = [
  {
    baseImage: 'ubuntu',
    baseImageVersion: '26.04',
    expectedDistribution: 'debian',
    id: 'ubuntu 26.04',
    kind: 'apt',
  },
  {
    baseImage: 'ubuntu',
    baseImageVersion: '24.04',
    expectedDistribution: 'debian',
    id: 'ubuntu 24.04',
    kind: 'apt',
  },
  {
    baseImage: 'debian',
    baseImageVersion: '13-slim',
    expectedDistribution: 'debian',
    id: 'debian 13-slim',
    kind: 'apt',
  },
  {
    baseImage: 'debian',
    baseImageVersion: '12-slim',
    expectedDistribution: 'debian',
    id: 'debian 12-slim',
    kind: 'apt',
  },
  {
    baseImage: 'archlinux',
    baseImageVersion: 'base-20260517.0.530531',
    expectedDistribution: 'arch',
    id: 'archlinux base-20260517.0.530531',
    kind: 'arch',
  },
  {
    baseImage: 'nixos/nix',
    baseImageVersion: '2.34.7',
    expectedDistribution: 'unknown',
    id: 'nix 2.34.7 container',
    kind: 'nix',
  },
] as const satisfies Array<BaseCase>
const runtimeVersions = {
  bun: '1.3.14',
  deno: '2.8.0',
  node: '26.2.0',
}
const runtimeCases = [
  {
    binarySourcePath: '/usr/local/bin/bun',
    builderImage: `oven/bun:${runtimeVersions.bun}`,
    id: 'bun',
    version: runtimeVersions.bun,
  },
  {
    binarySourcePath: '/usr/bin/deno',
    builderImage: `denoland/deno:${runtimeVersions.deno}`,
    id: 'deno',
    version: runtimeVersions.deno,
  },
  {
    binarySourcePath: '/usr/local/bin/node',
    builderImage: `node:${runtimeVersions.node}-bookworm-slim`,
    id: 'node',
    version: runtimeVersions.node,
  },
] as const satisfies Array<RuntimeCase>
const scriptCases = [
  {
    expected: {
      exports: {},
      returnValue: 'hi',
    },
    id: 'hello',
    inputCode: helloScript,
  },
  {
    expected: {
      exports: {
        arch: 'x64',
        platform: 'linux',
      },
      returnValue: undefined,
    },
    id: 'namedExports',
    inputCode: namedExportsScript,
  },
] as const satisfies Array<ScriptCase>
const buildTimeoutMs = 1_800_000
const cleanupTimeoutMs = 120_000
const commandTimeoutMs = 120_000
const matrixRootFolder = path.join(import.meta.dir, '../private/agent/matrix')
const quoteShell = (value: string) => {
  return JSON.stringify(value)
}
const toCommandText = (command: Array<string>) => {
  return command.map(argument => quoteShell(argument)).join(' ')
}
const toDockerSlug = (value: string) => {
  return value.toLowerCase().replaceAll(/[^0-9a-z]+/g, '-').replaceAll(/^-+|-+$/g, '')
}
const getFirstMeaningfulLine = (value: string | undefined) => {
  return value?.split(/\r?\n/u).find(line => line.trim().length > 0)?.trim()
}
const tail = (value: string | undefined, maxLength = 4000) => {
  if (!value) {
    return ''
  }
  return value.length <= maxLength ? value : value.slice(-maxLength)
}
const ensureCommandSucceeded = async (command: Array<string>, purpose: string, timeoutMs = commandTimeoutMs - 5000) => {
  const result = await runProcess(command, {
    timeoutMs,
    maxOutputBytes: 2_000_000,
  })
  if (result.exitCode === 0) {
    return result
  }
  throw new Error(`${purpose} failed with exit code ${result.exitCode}.\nCommand: ${toCommandText(command)}\n--- stdout ---\n${tail(result.stdout)}\n--- stderr ---\n${tail(result.stderr)}`)
}
const isCommandAvailable = async (command: Array<string>) => {
  try {
    const result = await runProcess(command, {
      timeoutMs: 5000,
      maxOutputBytes: 64_000,
    })
    return result.exitCode === 0
  } catch {
    return false
  }
}
const parseDockerHostSshTarget = (dockerHost = Bun.env.DOCKER_HOST) => {
  const normalized = dockerHost?.trim()
  if (!normalized?.startsWith('ssh://')) {
    return
  }
  const url = new URL(normalized)
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : undefined,
    user: url.username ? decodeURIComponent(url.username) : undefined,
  }
}
const resolveSshHostname = async (target: NonNullable<ReturnType<typeof parseDockerHostSshTarget>>) => {
  const destination = target.user ? `${target.user}@${target.host}` : target.host
  const result = await runProcess([
    'ssh',
    '-G',
    ...target.port === undefined ? [] : ['-p', String(target.port)],
    destination,
  ], {
    timeoutMs: 5000,
    maxOutputBytes: 128_000,
  })
  if (result.exitCode !== 0) {
    throw new Error(`Could not resolve Docker SSH host ${destination}.\n${result.stderr ?? ''}`)
  }
  const hostname = /^hostname\s+(?<hostname>.+)$/imu.exec(result.stdout ?? '')?.groups?.hostname.trim()
  return hostname || target.host
}
const dockerHostSshTarget = parseDockerHostSshTarget()
const skipIntegration = Bun.env.REMOTE_TARGET_SKIP_INTEGRATION === '1'
const matrixPrerequisitesAvailable = !skipIntegration && await (async () => {
  const [dockerAvailable, sshAvailable] = await Promise.all([
    isCommandAvailable(['docker', 'info']),
    isCommandAvailable(['ssh', '-V']),
  ])
  return dockerAvailable && sshAvailable
})()
const matrixDescribe = matrixPrerequisitesAvailable ? describe : describe.skip
if (!matrixPrerequisitesAvailable && !skipIntegration) {
  throw new Error('Docker and SSH are required for integration tests.')
}
const dockerSshHost = matrixPrerequisitesAvailable && dockerHostSshTarget ? await resolveSshHostname(dockerHostSshTarget) : undefined
const sshPublishAddress = dockerSshHost ? '0.0.0.0::22' : '127.0.0.1::22'
const getBaseSetupStep = (baseCase: BaseCase) => {
  if (baseCase.kind === 'apt') {
    return String.raw`ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends ca-certificates dropbear libatomic1 libstdc++6 procps \
 && rm -rf /var/lib/apt/lists/*`
  }
  if (baseCase.kind === 'arch') {
    return String.raw`ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN pacman -Syyu --noconfirm --needed ca-certificates dropbear gcc-libs procps-ng which`
  }
  return String.raw`ENV PATH=/usr/local/bin:/root/.nix-profile/bin:/nix/var/nix/profiles/default/bin:/nix/var/nix/profiles/default/sbin:/usr/bin:/bin
RUN nix-env -iA nixpkgs.dropbear nixpkgs.gcc.cc.lib nixpkgs.glibc nixpkgs.nix-ld nixpkgs.procps`
}
const getRuntimeSetupStep = (baseCase: BaseCase, runtimeCase: RuntimeCase) => {
  const runtimeBinaryPath = `/opt/remote-target/runtime/${runtimeCase.id}`
  if (baseCase.kind === 'nix') {
    return String.raw`RUN set -eux; \
  chmod +x ${runtimeBinaryPath}; \
  mkdir -p /lib64 /usr/local/bin; \
  cp "$(command -v nix-ld)" /lib64/ld-linux-x86-64.so.2; \
  NIX_LD="$(find /nix/store -name 'ld-linux-x86-64.so.2' | grep -v '/debug/' | tail -n 1)"; \
  NIX_LD_LIBRARY_PATH="$(dirname "$NIX_LD"):/root/.nix-profile/lib"; \
  { \
    echo '#!/bin/sh'; \
    echo "export NIX_LD=$NIX_LD"; \
    echo "export NIX_LD_LIBRARY_PATH=$NIX_LD_LIBRARY_PATH"; \
    echo 'exec ${runtimeBinaryPath} "$@"'; \
  } > /usr/local/bin/${runtimeCase.id}; \
  chmod +x /usr/local/bin/${runtimeCase.id}`
  }
  return String.raw`RUN set -eux; \
  chmod +x ${runtimeBinaryPath}; \
  mkdir -p /usr/bin; \
  { \
    echo '#!/bin/sh'; \
    echo 'exec ${runtimeBinaryPath} "$@"'; \
  } > /usr/bin/${runtimeCase.id}; \
  chmod +x /usr/bin/${runtimeCase.id}`
}
const getSshServerSetupStep = (baseCase: BaseCase) => {
  if (baseCase.kind === 'nix') {
    return String.raw`RUN set -eux; \
  mkdir -p /etc/dropbear /run/dropbear; \
  ROOT_SHELL="$(grep '^root:' /etc/passwd | cut -d: -f7)"; \
  printf '%s\n' "$ROOT_SHELL" /bin/sh > /etc/shells`
  }
  return String.raw`RUN set -eux; \
  mkdir -p /etc/dropbear /run/dropbear`
}
const getSshServerCommand = () => {
  return 'exec "$(command -v dropbear)" -F -E -R -s -g -p 22'
}
const createBaseContext = async (baseCase: BaseCase): Promise<BaseContext> => {
  await fs.mkdir(matrixRootFolder, {recursive: true})
  const folder = await fs.mkdtemp(path.join(matrixRootFolder, `${toDockerSlug(baseCase.id)}-`))
  const privateKeyFile = path.join(folder, 'id_ed25519')
  try {
    if (process.platform !== 'win32') {
      await fs.chmod(folder, 0o700)
    }
    const {privateKey, publicKey} = await makeSshKeys({comment: `remote-target-test-${toDockerSlug(baseCase.id)}`})
    await Promise.all([
      fs.writeFile(privateKeyFile, `${privateKey.trimEnd()}\n`),
      fs.writeFile(`${privateKeyFile}.pub`, `${publicKey.trimEnd()}\n`),
    ])
    if (process.platform !== 'win32') {
      await Promise.all([
        fs.chmod(privateKeyFile, 0o600),
        fs.chmod(`${privateKeyFile}.pub`, 0o644),
      ])
    }
    return {
      authorizedKey: publicKey.trim(),
      folder,
      privateKeyFile,
    }
  } catch (error) {
    await fs.rm(folder, {
      force: true,
      recursive: true,
    })
    throw error
  }
}
const renderDockerfile = (baseCase: BaseCase, runtimeCase: RuntimeCase, authorizedKey: string) => {
  return renderHandlebars(dockerfileTemplate, {
    baseSetupStep: getBaseSetupStep(baseCase),
    fullBaseImage: `${baseCase.baseImage}:${baseCase.baseImageVersion}`,
    runtimeBinaryPath: `/opt/remote-target/runtime/${runtimeCase.id}`,
    runtimeBinarySourcePath: runtimeCase.binarySourcePath,
    runtimeBuilderImage: runtimeCase.builderImage,
    runtimeSetupStep: getRuntimeSetupStep(baseCase, runtimeCase),
    sshServerCommand: getSshServerCommand(),
    sshServerSetupStep: getSshServerSetupStep(baseCase),
    sshAuthorizedKeyBase64: Buffer.from(authorizedKey, 'utf8').toString('base64'),
  })
}
const normalizePublishedSshHost = (host: string) => {
  const unbracketed = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (unbracketed === '0.0.0.0' || unbracketed === '::' || unbracketed === '127.0.0.1' || unbracketed === 'localhost') {
    return dockerSshHost ?? '127.0.0.1'
  }
  return unbracketed
}
const inspectPublishedSshEndpoint = async (containerName: string) => {
  const deadline = Date.now() + 30_000
  let lastStdout: string | undefined
  let lastStderr: string | undefined
  while (Date.now() < deadline) {
    const result = await runProcess(['docker', 'port', containerName, '22/tcp'], {
      timeoutMs: Math.min(5000, Math.max(0, deadline - Date.now())),
      maxOutputBytes: 64_000,
    })
    lastStdout = result.stdout
    lastStderr = result.stderr
    const lines = (result.stdout ?? '').trim().split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
    const preferredLine = dockerSshHost ? lines.find(line => !line.startsWith('127.0.0.1:')) ?? lines[0] : lines.find(line => line.startsWith('127.0.0.1:')) ?? lines[0]
    if (!preferredLine) {
      await Bun.sleep(500)
      continue
    }
    const match = /^(?<host>.+):(?<port>\d+)$/u.exec(preferredLine)
    const hostPort = match?.groups?.port ? Number(match.groups.port) : Number.NaN
    if (result.exitCode === 0 && match?.groups?.host && Number.isInteger(hostPort) && hostPort > 0) {
      return {
        host: normalizePublishedSshHost(match.groups.host),
        port: hostPort,
      }
    }
    await Bun.sleep(500)
  }
  throw new Error(`Expected a valid published SSH endpoint for ${containerName}, got stdout ${JSON.stringify(lastStdout)} and stderr ${JSON.stringify(lastStderr)}.`)
}
const getDockerLogs = async (containerName: string) => {
  const result = await runProcess(['docker', 'logs', '--tail', '200', containerName], {
    timeoutMs: 5000,
    maxOutputBytes: 64_000,
  })
  return [result.stdout, result.stderr].filter(Boolean).join('\n')
}
const waitForSsh = async (sshHost: string, knownHostsFile: string, sshConfigFile: string, privateKeyFile: string, hostPort: number, containerName: string) => {
  const deadline = Date.now() + 90_000
  const transport = new SshTargetTransport({
    host: sshHost,
    user: 'root',
    port: hostPort,
    keyFile: privateKeyFile,
    knownHostsFile,
    sshConfigFile,
    sshShell: 'posix',
    sshOptions: ['ConnectTimeout=2', 'StrictHostKeyChecking=accept-new', 'IdentitiesOnly=yes', 'LogLevel=ERROR'],
  })
  let lastResult: Awaited<ReturnType<typeof runProcess>> | undefined
  while (Date.now() < deadline) {
    lastResult = await transport.runShellNeutralCommand(['sh', '-c', 'printf ready'], {
      timeoutMs: Math.min(5000, Math.max(0, deadline - Date.now())),
      maxOutputBytes: 64_000,
    })
    if (lastResult.exitCode === 0 && lastResult.stdout?.trim() === 'ready') {
      return
    }
    await Bun.sleep(500)
  }
  const logs = await getDockerLogs(containerName)
  throw new Error(`SSH readiness failed.\n${tail(lastResult?.stderr)}\n${tail(logs)}`)
}
const destroyRuntimeContext = async (context: Partial<RuntimeContext> | undefined) => {
  if (!context) {
    return
  }
  if (context.containerName) {
    await runProcess(['docker', 'rm', '--force', context.containerName], {
      timeoutMs: 20_000,
      maxOutputBytes: 64_000,
    })
  }
  if (context.imageTag) {
    await runProcess(['docker', 'image', 'rm', context.imageTag], {
      timeoutMs: 20_000,
      maxOutputBytes: 64_000,
    })
  }
  if (context.runtimeWorkFolder) {
    await fs.rm(context.runtimeWorkFolder, {
      force: true,
      recursive: true,
    })
  }
}
const createRuntimeContext = async (baseCase: BaseCase, runtimeCase: RuntimeCase, baseContext: BaseContext): Promise<RuntimeContext> => {
  const runtimeWorkFolder = await fs.mkdtemp(path.join(baseContext.folder, `${runtimeCase.id}-`))
  const imageTag = `remote-target-matrix:${toDockerSlug(`${baseCase.baseImage}-${baseCase.baseImageVersion}-${runtimeCase.id}-${runtimeCase.version}`)}`
  const ownedImageTag = `${imageTag}-${crypto.randomUUID()}`
  const containerName = `${toDockerSlug(`${baseCase.baseImage}-${baseCase.baseImageVersion}-${runtimeCase.id}`)}-${crypto.randomUUID().slice(0, 8)}`
  const dockerfileFile = path.join(runtimeWorkFolder, 'Dockerfile')
  const knownHostsFile = path.join(runtimeWorkFolder, 'known_hosts')
  const sshConfigFile = path.join(runtimeWorkFolder, 'ssh_config')
  await fs.writeFile(sshConfigFile, '')
  const dockerfileContent = renderDockerfile(baseCase, runtimeCase, baseContext.authorizedKey)
  const runtimeContextDraft = {
    baseContext,
    containerId: '',
    containerName,
    discovery: undefined,
    dockerfileFile,
    hostPort: 0,
    imageTag: ownedImageTag,
    knownHostsFile,
    sshConfigFile,
    sshHost: '',
    remoteTarget: undefined,
    runtimeInfo: undefined,
    runtimeWorkFolder,
  } as Partial<RuntimeContext>
  try {
    await Bun.write(dockerfileFile, dockerfileContent)
    await ensureCommandSucceeded(['docker', 'build', '--tag', ownedImageTag, '--file', dockerfileFile, runtimeWorkFolder], `Building the Docker image for ${baseCase.id} with ${runtimeCase.id}`, buildTimeoutMs - 300_000)
    const runResult = await ensureCommandSucceeded(['docker', 'run', '--detach', '--publish', sshPublishAddress, '--name', containerName, ownedImageTag], `Starting the Docker container for ${baseCase.id} with ${runtimeCase.id}`)
    runtimeContextDraft.containerId = runResult.stdout?.trim() || containerName
    const endpoint = await inspectPublishedSshEndpoint(containerName)
    runtimeContextDraft.hostPort = endpoint.port
    runtimeContextDraft.sshHost = endpoint.host
    await waitForSsh(endpoint.host, knownHostsFile, sshConfigFile, baseContext.privateKeyFile, endpoint.port, containerName)
    const remoteTarget = new RemoteTarget({
      host: endpoint.host,
      keyFile: path.enforceForwardSlashes(baseContext.privateKeyFile),
      knownHostsFile,
      sshConfigFile,
      sshShell: 'posix',
      sshOptions: ['StrictHostKeyChecking=yes', 'IdentitiesOnly=yes', 'LogLevel=ERROR'],
      port: runtimeContextDraft.hostPort,
      runtimeCandidates: [runtimeCase.id],
      user: 'root',
    })
    await remoteTarget.init()
    runtimeContextDraft.remoteTarget = remoteTarget
    runtimeContextDraft.discovery = remoteTarget.getDiscovery()
    runtimeContextDraft.runtimeInfo = remoteTarget.getRuntime()
    return runtimeContextDraft as RuntimeContext
  } catch (error) {
    await destroyRuntimeContext(runtimeContextDraft)
    throw error
  }
}
for (const baseCase of baseCases) {
  matrixDescribe(baseCase.id, () => {
    let baseContext: BaseContext | undefined
    beforeAll(async () => {
      baseContext = await createBaseContext(baseCase)
    }, {timeout: commandTimeoutMs})
    afterAll(async () => {
      if (!baseContext) {
        return
      }
      await fs.rm(baseContext.folder, {
        force: true,
        recursive: true,
      })
    }, {timeout: cleanupTimeoutMs})
    for (const runtimeCase of runtimeCases) {
      describe(`${runtimeCase.id} runtime`, () => {
        let runtimeContext: RuntimeContext | undefined
        beforeAll(async () => {
          if (!baseContext) {
            throw new Error(`Expected the base context for ${baseCase.id} to be available.`)
          }
          runtimeContext = await createRuntimeContext(baseCase, runtimeCase, baseContext)
        }, {timeout: buildTimeoutMs})
        afterAll(async () => {
          await destroyRuntimeContext(runtimeContext)
        }, {timeout: cleanupTimeoutMs})
        test('init discovers runtime and base OS', () => {
          if (!runtimeContext) {
            throw new Error(`Expected the runtime context for ${baseCase.id} and ${runtimeCase.id} to be available.`)
          }
          const discoveredRuntime = runtimeContext.discovery.runtimes.find(candidate => candidate.name === runtimeCase.id)
          const resolvedRuntime = runtimeContext.runtimeInfo
          expect(runtimeContext.discovery.os.name).toBe('linux')
          if (runtimeContext.discovery.os.name !== 'linux') {
            throw new Error(`Expected ${baseCase.id} to be detected as Linux.`)
          }
          expect(runtimeContext.discovery.os.distribution).toBe(baseCase.expectedDistribution)
          expect(runtimeContext.discovery.runtimes.length).toBeGreaterThan(0)
          if (!discoveredRuntime) {
            throw new Error(`Expected ${baseCase.id} to expose ${runtimeCase.id} in its discovered runtimes.`)
          }
          expect(discoveredRuntime.name).toBe(runtimeCase.id)
          expect(discoveredRuntime.file).toContain(`/${runtimeCase.id}`)
          expect(discoveredRuntime.version).toContain(runtimeCase.version)
          expect(runtimeContext.discovery.shell.name).toBe('sh')
          expect(resolvedRuntime.name).toBe(runtimeCase.id)
          expect(resolvedRuntime.file).toContain(`/${runtimeCase.id}`)
          expect(resolvedRuntime.version).toContain(runtimeCase.version)
        }, {timeout: commandTimeoutMs})
        test('exec', async () => {
          if (!runtimeContext) {
            throw new Error(`Expected the runtime context for ${baseCase.id} and ${runtimeCase.id} to be available.`)
          }
          const result = await runtimeContext.remoteTarget.exec([runtimeCase.id, '--version'])
          const firstLine = getFirstMeaningfulLine(result.stdout)
          expect(result.command).toEqual([runtimeCase.id, '--version'])
          expect(result.exitCode).toBe(0)
          expect(firstLine).toContain(runtimeCase.version)
          expect(result.stderr).toBeUndefined()
        }, {timeout: commandTimeoutMs})
        for (const scriptCase of scriptCases) {
          describe(`${scriptCase.id} script`, () => {
            test('run', async () => {
              if (!runtimeContext) {
                throw new Error(`Expected the runtime context for ${baseCase.id} and ${runtimeCase.id} to be available.`)
              }
              const result = await runtimeContext.remoteTarget.run(scriptCase.inputCode)
              expect(result.exitCode).toBe(0)
              expect(result.inputCode).toBe(scriptCase.inputCode)
              expect(result.runtime.name).toBe(runtimeCase.id)
              expect(result.exports).toEqual(scriptCase.expected.exports)
              expect(result.returnValue).toEqual(scriptCase.expected.returnValue)
            }, {timeout: commandTimeoutMs})
          })
        }
      })
    }
  })
}
