import type {InvocationResult, TransportCommandOptions} from '../../remoteTarget/types.ts'

export abstract class TargetTransport {
  abstract runShellCommand(command: string, options?: TransportCommandOptions): Promise<InvocationResult>
  abstract runShellNeutralCommand(command: Array<string>, options?: TransportCommandOptions): Promise<InvocationResult>
}
