import {expect, test} from 'bun:test'

const {default: remoteTarget} = await import('#src/main.ts')

test('should run', () => {
  const result = remoteTarget()
  expect(result).toBe('remote-target') // TODO Test actual functionality
})
