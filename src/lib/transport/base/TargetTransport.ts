import type {InvocationResult, TransportCommandOptions} from '../../remoteTarget/types.ts'

export abstract class TargetTransport {
  abstract readonly id: string
  abstract runShellCommand(command: string): Promise<InvocationResult>
  abstract runShellNeutralCommand(command: Array<string>, options?: TransportCommandOptions): Promise<InvocationResult>
}
