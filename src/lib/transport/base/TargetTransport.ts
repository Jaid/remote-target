import type {InvocationResult, ShellInfo, TransportCommandOptions} from '../../remoteTarget/types.ts'

export type TransportCommand = ReadonlyArray<string> | string
export type TransportChunkStream = 'stderr' | 'stdout'
export type TransportChunkEvent = {
  chunk: Uint8Array
  command: TransportCommand
  invocationId: string
  stream: TransportChunkStream
}
export type TransportChunkListener = (event: TransportChunkEvent) => void

type ChunkListeners = Record<TransportChunkStream, Set<TransportChunkListener>>

export abstract class TargetTransport {
  readonly #chunkListeners: ChunkListeners = {
    stderr: new Set,
    stdout: new Set,
  }

  protected createChunkEmitter(commandInput: TransportCommand, options: TransportCommandOptions = {}) {
    const command = typeof commandInput === 'string' ? commandInput : [...commandInput]
    const invocationId = crypto.randomUUID()
    const emit = (stream: TransportChunkStream, chunk: Uint8Array) => {
      const event: TransportChunkEvent = {
        chunk,
        command,
        invocationId,
        stream,
      }
      for (const listener of this.#chunkListeners[stream]) {
        listener(event)
      }
    }
    return {
      invocationId,
      options: {
        ...options,
        onStderrChunk: (chunk: Uint8Array) => {
          options.onStderrChunk?.(chunk)
          emit('stderr', chunk)
        },
        onStdoutChunk: (chunk: Uint8Array) => {
          options.onStdoutChunk?.(chunk)
          emit('stdout', chunk)
        },
      } satisfies TransportCommandOptions,
      stderr: (chunk: Uint8Array) => {
        options.onStderrChunk?.(chunk)
        emit('stderr', chunk)
      },
      stdout: (chunk: Uint8Array) => {
        options.onStdoutChunk?.(chunk)
        emit('stdout', chunk)
      },
    }
  }

  getShell(): ShellInfo | undefined {
    return undefined
  }

  off(stream: TransportChunkStream, listener: TransportChunkListener) {
    this.#chunkListeners[stream].delete(listener)
  }

  on(stream: TransportChunkStream, listener: TransportChunkListener) {
    this.#chunkListeners[stream].add(listener)
    return () => {
      this.off(stream, listener)
    }
  }
  abstract runShellCommand(command: string, options?: TransportCommandOptions): Promise<InvocationResult>

  abstract runShellNeutralCommand(command: Array<string>, options?: TransportCommandOptions): Promise<InvocationResult>
}
