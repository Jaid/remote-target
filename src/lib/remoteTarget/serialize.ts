const transportTagKey = '__remoteTargetType'

type TaggedTransportValue = {
  [key: string]: unknown
  [transportTagKey]: string
}

const getTransportTag = (value: unknown) => {
  if (!value || typeof value !== 'object') {
    return
  }
  const candidate = value as Record<string, unknown>
  if (!Object.hasOwn(value, transportTagKey)) {
    return
  }
  const tag = candidate[transportTagKey]
  return typeof tag === 'string' ? tag : undefined
}

// Keep this as a function declaration. RemoteTarget stringifies it into wrapper scripts and may rebind it under a different variable name, so recursive calls and tag lookup must stay self-contained.
export function serializeTransportValue(value: unknown, seen = new WeakSet<object>): unknown {
  const localTransportTagKey = '__remoteTargetType'
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value
  }
  if (value === undefined) {
    return {[localTransportTagKey]: 'undefined'}
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) {
      return {[localTransportTagKey]: 'nan'}
    }
    if (!Number.isFinite(value)) {
      return {
        [localTransportTagKey]: 'infinity',
        sign: Math.sign(value),
      }
    }
    return value
  }
  if (typeof value === 'bigint') {
    return {
      [localTransportTagKey]: 'bigint',
      value: value.toString(),
    }
  }
  if (typeof value === 'function') {
    return {
      [localTransportTagKey]: 'function',
      value: value.name || 'anonymous',
    }
  }
  if (typeof value === 'symbol') {
    return {
      [localTransportTagKey]: 'symbol',
      value: String(value),
    }
  }
  if (seen.has(value)) {
    return {[localTransportTagKey]: 'circular'}
  }
  seen.add(value)
  try {
    if (value instanceof Date) {
      return {
        [localTransportTagKey]: 'date',
        value: Number.isNaN(value.valueOf()) ? String(value) : value.toISOString(),
      }
    }
    if (value instanceof Error) {
      return {
        [localTransportTagKey]: 'error',
        cause: value.cause === undefined ? undefined : serializeTransportValue(value.cause, seen),
        message: value.message,
        name: value.name,
        stack: value.stack,
      }
    }
    if (value instanceof Map) {
      return {
        [localTransportTagKey]: 'map',
        value: [...value.entries()].map(([key, item]) => [serializeTransportValue(key, seen), serializeTransportValue(item, seen)]),
      }
    }
    if (value instanceof RegExp) {
      return {
        [localTransportTagKey]: 'regexp',
        flags: value.flags,
        source: value.source,
      }
    }
    if (value instanceof Set) {
      return {
        [localTransportTagKey]: 'set',
        value: [...value].map(item => serializeTransportValue(item, seen)),
      }
    }
    if (value instanceof URL) {
      return {
        [localTransportTagKey]: 'url',
        value: value.toString(),
      }
    }
    if (value instanceof ArrayBuffer) {
      return {
        [localTransportTagKey]: 'arrayBuffer',
        value: Buffer.from(value).toString('base64'),
      }
    }
    if (ArrayBuffer.isView(value)) {
      return {
        [localTransportTagKey]: 'typedArray',
        name: value.constructor.name,
        value: Buffer.from(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)).toString('base64'),
      }
    }
    if (Array.isArray(value)) {
      return value.map(item => serializeTransportValue(item, seen))
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializeTransportValue(item, seen)]))
  } finally {
    seen.delete(value)
  }
}

export function deserializeTransportValue(value: unknown): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value
  }
  if (Array.isArray(value)) {
    return value.map(item => deserializeTransportValue(item))
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  const tag = getTransportTag(value)
  if (!tag) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deserializeTransportValue(item)]))
  }
  const taggedValue = value as TaggedTransportValue
  if (tag === 'arrayBuffer') {
    const buffer = taggedValue.value
    if (typeof buffer !== 'string') {
      return value
    }
    const decodedBuffer = Buffer.from(buffer, 'base64')
    return decodedBuffer.buffer.slice(decodedBuffer.byteOffset, decodedBuffer.byteOffset + decodedBuffer.byteLength)
  }
  if (tag === 'bigint') {
    return typeof taggedValue.value === 'string' ? BigInt(taggedValue.value) : value
  }
  if (tag === 'circular') {
    return '[Circular]'
  }
  if (tag === 'date') {
    return typeof taggedValue.value === 'string' ? new Date(taggedValue.value) : value
  }
  if (tag === 'error') {
    const error = new Error(typeof taggedValue.message === 'string' ? taggedValue.message : 'Remote error')
    if (typeof taggedValue.name === 'string') {
      error.name = taggedValue.name
    }
    if (typeof taggedValue.stack === 'string') {
      error.stack = taggedValue.stack
    }
    if (taggedValue.cause !== undefined) {
      error.cause = deserializeTransportValue(taggedValue.cause)
    }
    return error
  }
  if (tag === 'function') {
    return `[Function ${typeof taggedValue.value === 'string' ? taggedValue.value : 'anonymous'}]`
  }
  if (tag === 'infinity') {
    return taggedValue.sign === -1 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY
  }
  if (tag === 'map') {
    if (!Array.isArray(taggedValue.value)) {
      return value
    }
    return new Map(taggedValue.value.map(item => {
      if (!Array.isArray(item) || item.length < 2) {
        return [item, item] as const
      }
      return [deserializeTransportValue(item[0]), deserializeTransportValue(item[1])] as const
    }))
  }
  if (tag === 'nan') {
    return Number.NaN
  }
  if (tag === 'regexp') {
    const source = typeof taggedValue.source === 'string' ? taggedValue.source : ''
    const flags = typeof taggedValue.flags === 'string' ? taggedValue.flags : ''
    return new RegExp(source, flags)
  }
  if (tag === 'set') {
    return new Set(Array.isArray(taggedValue.value) ? taggedValue.value.map(item => deserializeTransportValue(item)) : [])
  }
  if (tag === 'symbol') {
    return typeof taggedValue.value === 'string' ? Symbol.for(taggedValue.value) : Symbol()
  }
  if (tag === 'typedArray') {
    if (typeof taggedValue.name !== 'string' || typeof taggedValue.value !== 'string') {
      return value
    }
    const buffer = Buffer.from(taggedValue.value, 'base64')
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    type TypedArrayConstructor = new (buffer: ArrayBufferLike) => ArrayBufferView
    const constructors: Partial<Record<string, TypedArrayConstructor>> = {
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
    const Constructor = constructors[taggedValue.name]
    return Constructor ? new Constructor(arrayBuffer) : arrayBuffer
  }
  if (tag === 'undefined') {
    return undefined
  }
  if (tag === 'url') {
    return typeof taggedValue.value === 'string' ? new URL(taggedValue.value) : value
  }
  return value
}

export const serializeRemoteError = (error: unknown) => {
  if (error instanceof Error) {
    return serializeTransportValue(error)
  }
  return serializeTransportValue(new Error(String(error)))
}
