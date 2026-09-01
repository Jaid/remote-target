const transportEnvelopeKey = '__remoteTargetEnvelope'
const transportEnvelopeVersion = 1

type TransportEnvelope = {
  [transportEnvelopeKey]: {
    data?: unknown
    name?: string
    type: string
    version: number
  }
}

const getEnvelope = (value: unknown) => {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, transportEnvelopeKey)) {
    return
  }
  const envelope = (value as TransportEnvelope)[transportEnvelopeKey]
  if (typeof envelope !== 'object' || envelope.version !== transportEnvelopeVersion || typeof envelope.type !== 'string') {
    throw new TypeError('Malformed remote-target transport envelope.')
  }
  return envelope
}

// Keep this as a function declaration. RemoteTarget stringifies it into wrapper scripts and may rebind it under another name, so recursive calls must stay self-contained.
export function serializeTransportValue(value: unknown, seen = new WeakSet<object>): unknown {
  const envelopeKey = '__remoteTargetEnvelope'
  const wrap = (type: string, data?: unknown, name?: string) => ({
    [envelopeKey]: {
      ...data === undefined ? {} : {data},
      ...name === undefined ? {} : {name},
      type,
      version: 1,
    },
  })
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value
  }
  if (value === undefined) {
    return wrap('undefined')
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) {
      return wrap('nan')
    }
    if (!Number.isFinite(value)) {
      return wrap('infinity', Math.sign(value))
    }
    return value
  }
  if (typeof value === 'bigint') {
    return wrap('bigint', value.toString())
  }
  if (typeof value === 'function') {
    return wrap('function', value.name || 'anonymous')
  }
  if (typeof value === 'symbol') {
    const globalKey = Symbol.keyFor(value)
    return wrap('symbol', globalKey ?? value.description, globalKey === undefined ? 'local' : 'global')
  }
  if (seen.has(value)) {
    return wrap('circular')
  }
  seen.add(value)
  try {
    if (value instanceof Date) {
      return wrap('date', Number.isNaN(value.valueOf()) ? null : value.toISOString())
    }
    if (value instanceof Error) {
      return wrap('error', {
        cause: value.cause === undefined ? undefined : serializeTransportValue(value.cause, seen),
        message: value.message,
        name: value.name,
        stack: value.stack,
      })
    }
    if (value instanceof Map) {
      return wrap('map', [...value].map(([key, item]) => [serializeTransportValue(key, seen), serializeTransportValue(item, seen)]))
    }
    if (value instanceof RegExp) {
      return wrap('regexp', {
        flags: value.flags,
        source: value.source,
      })
    }
    if (value instanceof Set) {
      return wrap('set', [...value].map(item => serializeTransportValue(item, seen)))
    }
    if (value instanceof URL) {
      return wrap('url', value.toString())
    }
    if (value instanceof ArrayBuffer) {
      return wrap('arrayBuffer', Buffer.from(value).toString('base64'))
    }
    if (value instanceof DataView) {
      return wrap('dataView', Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64'))
    }
    if (ArrayBuffer.isView(value)) {
      const supportedNames = new Set(['BigInt64Array', 'BigUint64Array', 'Float32Array', 'Float64Array', 'Int16Array', 'Int32Array', 'Int8Array', 'Uint16Array', 'Uint32Array', 'Uint8Array', 'Uint8ClampedArray'])
      const name = value.constructor.name
      if (!supportedNames.has(name)) {
        throw new TypeError(`Unsupported typed array: ${name}.`)
      }
      return wrap('typedArray', Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64'), name)
    }
    if (Array.isArray(value)) {
      return wrap('array', value.map(item => serializeTransportValue(item, seen)))
    }
    return wrap('object', Object.entries(value).map(([key, item]) => [key, serializeTransportValue(item, seen)]))
  } finally {
    seen.delete(value)
  }
}

const decodeArrayBuffer = (value: unknown) => {
  if (typeof value !== 'string') {
    throw new TypeError('Expected base64 transport data.')
  }
  const buffer = Buffer.from(value, 'base64')
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
}

export function deserializeTransportValue(value: unknown): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value
  }
  const envelope = getEnvelope(value)
  if (!envelope) {
    throw new TypeError('Expected a remote-target transport envelope.')
  }
  const {data, name, type} = envelope
  if (type === 'undefined') {
    return undefined
  }
  if (type === 'nan') {
    return Number.NaN
  }
  if (type === 'infinity') {
    return data === -1 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY
  }
  if (type === 'bigint') {
    return BigInt(String(data))
  }
  if (type === 'function') {
    return `[Function ${typeof data === 'string' ? data : 'anonymous'}]`
  }
  if (type === 'symbol') {
    return name === 'global' ? Symbol.for(String(data)) : Symbol(typeof data === 'string' ? data : undefined)
  }
  if (type === 'circular') {
    return '[Circular]'
  }
  if (type === 'date') {
    if (data !== null && typeof data !== 'string') {
      throw new TypeError('Malformed date transport payload.')
    }
    return new Date(data === null ? Number.NaN : data)
  }
  if (type === 'url') {
    return new URL(String(data))
  }
  if (type === 'arrayBuffer') {
    return decodeArrayBuffer(data)
  }
  if (type === 'dataView') {
    return new DataView(decodeArrayBuffer(data))
  }
  if (type === 'array') {
    if (!Array.isArray(data)) {
      throw new TypeError('Malformed array transport payload.')
    }
    return data.map(item => deserializeTransportValue(item))
  }
  if (type === 'object') {
    if (!Array.isArray(data) || data.some(entry => !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string')) {
      throw new TypeError('Malformed object transport payload.')
    }
    const entries = data as Array<[string, unknown]>
    return Object.fromEntries(entries.map(entry => [entry[0], deserializeTransportValue(entry[1])]))
  }
  if (type === 'map') {
    if (!Array.isArray(data) || data.some(entry => !Array.isArray(entry) || entry.length !== 2)) {
      throw new TypeError('Malformed map transport payload.')
    }
    const entries = data as Array<[unknown, unknown]>
    return new Map(entries.map(entry => [deserializeTransportValue(entry[0]), deserializeTransportValue(entry[1])]))
  }
  if (type === 'set') {
    if (!Array.isArray(data)) {
      throw new TypeError('Malformed set transport payload.')
    }
    return new Set(data.map(item => deserializeTransportValue(item)))
  }
  if (type === 'regexp') {
    if (!data || typeof data !== 'object') {
      throw new TypeError('Malformed RegExp transport payload.')
    }
    const regexp = data as Record<string, unknown>
    return new RegExp(typeof regexp.source === 'string' ? regexp.source : '', typeof regexp.flags === 'string' ? regexp.flags : '')
  }
  if (type === 'error') {
    if (!data || typeof data !== 'object') {
      throw new TypeError('Malformed error transport payload.')
    }
    const details = data as Record<string, unknown>
    const error = new Error(typeof details.message === 'string' ? details.message : 'Remote error')
    if (typeof details.name === 'string') {
      error.name = details.name
    }
    if (typeof details.stack === 'string') {
      error.stack = details.stack
    }
    if (details.cause !== undefined) {
      error.cause = deserializeTransportValue(details.cause)
    }
    return error
  }
  if (type === 'typedArray') {
    type TypedArrayConstructor = new (buffer: ArrayBufferLike) => ArrayBufferView
    const constructors: Record<string, TypedArrayConstructor> = {
      BigInt64Array,
      BigUint64Array,
      Float32Array,
      Float64Array,
      Int16Array,
      Int32Array,
      Int8Array,
      Uint16Array,
      Uint32Array,
      Uint8Array,
      Uint8ClampedArray,
    }
    const Constructor = name ? constructors[name] : undefined
    if (!Constructor) {
      throw new TypeError(`Unsupported typed array transport payload: ${String(name)}.`)
    }
    return new Constructor(decodeArrayBuffer(data))
  }
  throw new TypeError(`Unknown remote-target transport type: ${type}.`)
}
