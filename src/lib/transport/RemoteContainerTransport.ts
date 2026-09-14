import type {ContainerTransportOptions} from './ContainerTransport.ts'

import {ContainerTransport} from './ContainerTransport.ts'

export type RemoteContainerTransportOptions = ContainerTransportOptions & {
  /** Docker daemon endpoint, such as ssh://nas, tcp://nas:2375 or https://docker.example:2376. */
  endpoint: string
}

const getEndpointArguments = (endpoint: string): Array<string> => {
  if (/^https?:\/\//iu.test(endpoint)) {
    const url = new URL(endpoint)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new TypeError('Docker HTTP endpoints must not contain credentials, a path, a query or a fragment.')
    }
    const secure = url.protocol === 'https:'
    const host = `tcp://${url.hostname}:${url.port || (secure ? '443' : '80')}`
    // Docker accepts TCP sockets, not HTTP URL schemes. Never silently disable HTTPS verification.
    return ['--host', host, ...secure ? ['--tlsverify'] : ['--tls=false']]
  }
  if (!/^(?:npipe|ssh|tcp|unix):\/\//u.test(endpoint) || endpoint.includes('\0')) {
    throw new TypeError('Expected a Docker endpoint using ssh://, tcp://, unix://, npipe://, http:// or https://.')
  }
  return ['--host', endpoint]
}

/** Targets an existing container through an explicit Docker daemon endpoint. */
export class RemoteContainerTransport extends ContainerTransport {
  readonly endpoint: string
  readonly #endpointArguments: Array<string>

  constructor(options: RemoteContainerTransportOptions)
  constructor(container: string, endpoint: string, options?: Omit<ContainerTransportOptions, 'container'>)
  constructor(input: RemoteContainerTransportOptions | string, endpoint?: string, extraOptions: Omit<ContainerTransportOptions, 'container'> = {}) {
    const options = typeof input === 'string' ? {
      container: input,
      endpoint,
      ...extraOptions,
    } : input
    super(options)
    if (!options.endpoint?.trim()) {
      throw new TypeError('Expected a non-empty Docker endpoint.')
    }
    this.endpoint = options.endpoint.trim()
    this.#endpointArguments = getEndpointArguments(this.endpoint)
  }

  protected override getDockerBaseCommand(): Array<string> {
    return [...super.getDockerBaseCommand(), ...this.#endpointArguments]
  }

  protected override getDockerEnvironment(): Record<string, string | undefined> {
    const environment = super.getDockerEnvironment()
    if (!/^http:\/\//iu.test(this.endpoint)) {
      return environment
    }
    // Even --tlsverify=false enables TLS. Clear inherited TLS switches for this CLI process only.
    return {
      ...environment,
      DOCKER_TLS: '',
      DOCKER_TLS_VERIFY: '',
    }
  }
}
