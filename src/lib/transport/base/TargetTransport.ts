import type {ShellInfo, TransportCommandOptions, TransportResult} from '../../remoteTarget/types.ts'

export abstract class TargetTransport {
  getShell(): ShellInfo | undefined {
    return undefined
  }

  abstract runShellCommand(command: string, options?: TransportCommandOptions): Promise<TransportResult>
  abstract runShellNeutralCommand(command: Array<string>, options?: TransportCommandOptions): Promise<TransportResult>
}
