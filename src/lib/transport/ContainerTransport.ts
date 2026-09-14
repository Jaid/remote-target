import type {InvocationResult, TransportCommandOptions} from '../remoteTarget/types.ts'

import {runProcess} from '../remoteTarget/runProcess.ts'
import {TargetTransport} from './base/TargetTransport.ts'

export type ContainerTransportOptions = {
  /** ID or name of an existing, running container. The transport does not own its lifecycle. */
  container: string
  /** Local Docker executable or argv prefix, for example ['docker', '--context', 'nas']. */
  dockerCommand?: ReadonlyArray<string> | string
  /** Interpreter prefix for runShellCommand() only. Defaults to ['sh', '-c'] inside the container. */
  shellCommand?: ReadonlyArray<string>
  /** Container username or UID, optionally followed by :group or :gid. */
  user?: string
}

const validateCommand = (command: ReadonlyArray<string>) => {
  if (!command[0] || command.some(argument => argument.includes('\0'))) {
    throw new TypeError('Expected a non-empty command without NUL arguments.')
  }
}

/**
 * Executes through the local Docker CLI, honoring its current context and environment.
 * Timeouts and cancellation terminate the CLI, not necessarily the process inside the container.
 */
export class ContainerTransport extends TargetTransport {
  readonly container: string
  readonly dockerCommand: ReadonlyArray<string>
  readonly shellCommand: ReadonlyArray<string>
  readonly user?: string

  constructor(input: ContainerTransportOptions | string, extraOptions: Omit<ContainerTransportOptions, 'container'> = {}) {
    super()
    const options = {
      ...typeof input === 'string' ? {container: input} : input,
      ...extraOptions,
    }
    if (!options.container.trim() || options.container.includes('\0')) {
      throw new TypeError('Expected a non-empty container ID or name without NUL.')
    }
    const dockerCommand = options.dockerCommand ?? 'docker'
    this.container = options.container
    this.dockerCommand = typeof dockerCommand === 'string' ? [dockerCommand] : [...dockerCommand]
    this.shellCommand = [...options.shellCommand ?? ['sh', '-c']]
    this.user = options.user
    validateCommand(this.dockerCommand)
    validateCommand(this.shellCommand)
  }

  protected getDockerBaseCommand(): Array<string> {
    return [...this.dockerCommand]
  }

  /** Environment for the local Docker CLI, not for the command inside the container. */
  protected getDockerEnvironment(): Record<string, string | undefined> {
    return process.env
  }

  protected runContainer(command: Array<string>, options: TransportCommandOptions): Promise<InvocationResult> {
    validateCommand(command)
    return runProcess([
      ...this.getDockerBaseCommand(),
      'exec',
      ...options.stdin === undefined ? [] : ['--interactive'],
      ...this.user === undefined ? [] : ['--user', this.user],
      '--',
      this.container,
      ...command,
    ], options, this.getDockerEnvironment())
  }

  override runShellCommand(command: string, options: TransportCommandOptions = {}): Promise<InvocationResult> {
    return this.runContainer([...this.shellCommand, command], this.createChunkEmitter(command, options).options)
  }

  override runShellNeutralCommand(command: Array<string>, options: TransportCommandOptions = {}): Promise<InvocationResult> {
    return this.runContainer(command, this.createChunkEmitter(command, options).options)
  }
}
