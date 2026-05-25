/* eslint-disable typescript/no-restricted-imports -- avoiding a dedicated test-only dependency here is preferable. */
import type {LinuxDistribution, RuntimeName} from '#src/lib/remoteTarget/index.ts'

import {afterAll, beforeAll, describe, expect, test} from 'bun:test'
import {mkdir, mkdtemp, readFile, rm} from 'node:fs/promises'
import path from 'node:path'

import {renderHandlebars} from 'zeug'

import {runProcess} from '#src/lib/remoteTarget/runProcess.ts'
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
  folder: string
  privateKeyFile: string
  publicKey: string
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
}

const dockerfileTemplate = await readFile(path.join(import.meta.dir, 'lib/Dockerfile.hbs'), 'utf8')
const helloScript = await readFile(path.join(import.meta.dir, 'fixture/script/hello.ts'), 'utf8')
const namedExportsScript = await readFile(path.join(import.meta.dir, 'fixture/script/namedExports.ts'), 'utf8')
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
    id: 'nixos/nix 2.34.7',
    kind: 'nix',
  },
] as const satisfies Array<BaseCase>
const runtimeCases = [
  {
    binarySourcePath: '/usr/local/bin/bun',
    builderImage: 'oven/bun:1.3.14',
    id: 'bun',
    version: '1.3.14',
  },
  {
    binarySourcePath: '/usr/bin/deno',
    builderImage: 'denoland/deno:2.8.0',
    id: 'deno',
    version: '2.8.0',
  },
  {
    binarySourcePath: '/usr/local/bin/node',
    builderImage: 'node:26.2.0-bookworm-slim',
    id: 'node',
    version: '26.2.0',
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
const sshKeygenCommand = process.platform === 'win32' ? 'ssh-keygen.exe' : 'ssh-keygen'
const sshKeygenProbeCommand = process.platform === 'win32' ? ['where.exe', sshKeygenCommand] : ['which', sshKeygenCommand]
const normalizePath = (value: string) => value.replaceAll('\\', '/')
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
const ensureCommandSucceeded = async (command: Array<string>, purpose: string) => {
  const result = await runProcess(command)
  if (result.exitCode === 0) {
    return result
  }
  throw new Error(`${purpose} failed with exit code ${result.exitCode}.\nCommand: ${toCommandText(command)}\n--- stdout ---\n${tail(result.stdout)}\n--- stderr ---\n${tail(result.stderr)}`)
}
const isCommandAvailable = async (command: Array<string>) => {
  try {
    const result = await runProcess(command)
    return result.exitCode === 0
  } catch {
    return false
  }
}
const matrixPrerequisitesAvailable = await (async () => {
  const [dockerAvailable, sshKeygenAvailable] = await Promise.all([
    isCommandAvailable(['docker', 'info']),
    isCommandAvailable(sshKeygenProbeCommand),
  ])
  return dockerAvailable && sshKeygenAvailable
})()
const matrixDescribe = matrixPrerequisitesAvailable ? describe : describe.skip
const getBaseSetupStep = (baseCase: BaseCase) => {
  if (baseCase.kind === 'apt') {
    return String.raw`RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends ca-certificates libatomic1 libstdc++6 openssh-server procps \
 && rm -rf /var/lib/apt/lists/*`
  }
  if (baseCase.kind === 'arch') {
    return String.raw`RUN pacman -Syyu --noconfirm --needed ca-certificates gcc-libs openssh procps-ng which`
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
  mkdir -p /usr/local/bin; \
  { \
    echo '#!/bin/sh'; \
    echo 'exec ${runtimeBinaryPath} "$@"'; \
  } > /usr/local/bin/${runtimeCase.id}; \
  chmod +x /usr/local/bin/${runtimeCase.id}`
}
const getSshServerSetupStep = (baseCase: BaseCase) => {
  if (baseCase.kind === 'nix') {
    return String.raw`RUN set -eux; \
  mkdir -p /etc/dropbear /run/dropbear; \
  ROOT_SHELL="$(grep '^root:' /etc/passwd | cut -d: -f7)"; \
  printf '%s\n' "$ROOT_SHELL" /bin/sh > /etc/shells`
  }
  return String.raw`RUN set -eux; \
  mkdir -p /etc/ssh /run/sshd; \
  ssh-keygen -A; \
  { \
    echo 'Port 22'; \
    echo 'AddressFamily any'; \
    echo 'ListenAddress 0.0.0.0'; \
    echo 'ListenAddress ::'; \
    echo 'PermitRootLogin yes'; \
    echo 'PasswordAuthentication no'; \
    echo 'KbdInteractiveAuthentication no'; \
    echo 'ChallengeResponseAuthentication no'; \
    echo 'UsePAM no'; \
    echo 'PubkeyAuthentication yes'; \
    echo 'AuthorizedKeysFile .ssh/authorized_keys'; \
    echo 'PidFile /run/sshd.pid'; \
    echo 'PrintMotd no'; \
    echo 'Subsystem sftp internal-sftp'; \
  } > /etc/ssh/sshd_config`
}
const getSshServerCommand = (baseCase: BaseCase) => {
  if (baseCase.kind === 'nix') {
    return 'exec "$(command -v dropbear)" -F -E -R -s -g -p 22'
  }
  return 'exec "$(command -v sshd)" -D -e -f /etc/ssh/sshd_config'
}
const createBaseContext = async (baseCase: BaseCase): Promise<BaseContext> => {
  await mkdir(matrixRootFolder, {recursive: true})
  const folder = await mkdtemp(path.join(matrixRootFolder, `${toDockerSlug(baseCase.id)}-`))
  const privateKeyFile = path.join(folder, 'id_ed25519')
  await ensureCommandSucceeded([sshKeygenCommand, '-q', '-t', 'ed25519', '-N', '', '-C', `remote-target-test-${toDockerSlug(baseCase.id)}`, '-f', privateKeyFile], `Generating a temporary SSH key for ${baseCase.id}`)
  const publicKey = await readFile(`${privateKeyFile}.pub`, 'utf8')
  return {
    folder,
    privateKeyFile,
    publicKey,
  }
}
const renderDockerfile = (baseCase: BaseCase, runtimeCase: RuntimeCase, publicKey: string) => {
  return renderHandlebars(dockerfileTemplate, {
    baseSetupStep: getBaseSetupStep(baseCase),
    fullBaseImage: `${baseCase.baseImage}:${baseCase.baseImageVersion}`,
    runtimeBinaryPath: `/opt/remote-target/runtime/${runtimeCase.id}`,
    runtimeBinarySourcePath: runtimeCase.binarySourcePath,
    runtimeBuilderImage: runtimeCase.builderImage,
    runtimeSetupStep: getRuntimeSetupStep(baseCase, runtimeCase),
    sshServerCommand: getSshServerCommand(baseCase),
    sshServerSetupStep: getSshServerSetupStep(baseCase),
    sshPublicKeyBase64: Buffer.from(publicKey, 'utf8').toString('base64'),
  })
}
const inspectPublishedSshPort = async (containerName: string) => {
  const deadline = Date.now() + 30_000
  let lastStdout: string | undefined
  let lastStderr: string | undefined
  while (Date.now() < deadline) {
    const result = await runProcess(['docker', 'port', containerName, '22/tcp'])
    lastStdout = result.stdout
    lastStderr = result.stderr
    const match = /:(?<port>\d+)\s*$/u.exec(result.stdout ?? '')
    const hostPort = match?.groups?.port ? Number(match.groups.port) : Number.NaN
    if (result.exitCode === 0 && Number.isInteger(hostPort) && hostPort > 0) {
      return hostPort
    }
    await Bun.sleep(500)
  }
  throw new Error(`Expected a valid published SSH port for ${containerName}, got stdout ${JSON.stringify(lastStdout)} and stderr ${JSON.stringify(lastStderr)}.`)
}
const getDockerLogs = async (containerName: string) => {
  const result = await runProcess(['docker', 'logs', containerName])
  return [result.stdout, result.stderr].filter(Boolean).join('\n')
}
const waitForSsh = async (knownHostsFile: string, privateKeyFile: string, hostPort: number, containerName: string) => {
  const deadline = Date.now() + 120_000
  let lastResult: Awaited<ReturnType<typeof runProcess>> | undefined
  while (Date.now() < deadline) {
    lastResult = await runProcess([
      'ssh',
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=2',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      `UserKnownHostsFile=${knownHostsFile}`,
      '-i',
      privateKeyFile,
      '-p',
      String(hostPort),
      'root@127.0.0.1',
      'printf ready',
    ])
    if (lastResult.exitCode === 0 && lastResult.stdout?.trim() === 'ready') {
      return
    }
    await Bun.sleep(1000)
  }
  const dockerLogs = await getDockerLogs(containerName)
  throw new Error(`The SSH server in ${containerName} did not become ready in time.\n--- stdout ---\n${tail(lastResult?.stdout)}\n--- stderr ---\n${tail(lastResult?.stderr)}\n--- docker logs ---\n${tail(dockerLogs, 8000)}`)
}
const destroyRuntimeContext = async (runtimeContext: RuntimeContext | undefined) => {
  if (!runtimeContext) {
    return
  }
  await Promise.allSettled([
    runProcess(['docker', 'rm', '--force', runtimeContext.containerName]),
    rm(runtimeContext.runtimeWorkFolder, {
      force: true,
      recursive: true,
    }),
  ])
}
const createRuntimeContext = async (baseCase: BaseCase, runtimeCase: RuntimeCase, baseContext: BaseContext): Promise<RuntimeContext> => {
  const runtimeWorkFolder = await mkdtemp(path.join(baseContext.folder, `${runtimeCase.id}-`))
  const imageTag = `remote-target-matrix:${toDockerSlug(`${baseCase.baseImage}-${baseCase.baseImageVersion}-${runtimeCase.id}-${runtimeCase.version}`)}`
  const containerName = `${toDockerSlug(`${baseCase.baseImage}-${baseCase.baseImageVersion}-${runtimeCase.id}`)}-${crypto.randomUUID().slice(0, 8)}`
  const dockerfileFile = path.join(runtimeWorkFolder, 'Dockerfile')
  const knownHostsFile = path.join(runtimeWorkFolder, 'known_hosts')
  const dockerfileContent = renderDockerfile(baseCase, runtimeCase, baseContext.publicKey)
  const runtimeContextDraft = {
    baseContext,
    containerId: '',
    containerName,
    discovery: undefined,
    dockerfileFile,
    hostPort: 0,
    imageTag,
    knownHostsFile,
    remoteTarget: undefined,
    runtimeInfo: undefined,
    runtimeWorkFolder,
  } as Partial<RuntimeContext>
  try {
    await Bun.write(dockerfileFile, dockerfileContent)
    await ensureCommandSucceeded(['docker', 'build', '--tag', imageTag, '--file', dockerfileFile, runtimeWorkFolder], `Building the Docker image for ${baseCase.id} with ${runtimeCase.id}`)
    const runResult = await ensureCommandSucceeded(['docker', 'run', '--detach', '--publish', '127.0.0.1::22', '--name', containerName, imageTag], `Starting the Docker container for ${baseCase.id} with ${runtimeCase.id}`)
    runtimeContextDraft.containerId = runResult.stdout?.trim() || containerName
    runtimeContextDraft.hostPort = await inspectPublishedSshPort(containerName)
    await waitForSsh(knownHostsFile, baseContext.privateKeyFile, runtimeContextDraft.hostPort, containerName)
    const remoteTarget = new RemoteTarget({
      host: '127.0.0.1',
      keyFile: normalizePath(baseContext.privateKeyFile),
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
    await destroyRuntimeContext(runtimeContextDraft as RuntimeContext)
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
      await rm(baseContext.folder, {
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
          expect(runtimeContext.discovery.shell.name).toBe('bash')
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
