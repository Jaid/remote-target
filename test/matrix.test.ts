import {beforeAll, describe, expect, test} from 'bun:test'

import {renderHandlebars} from 'zeug'

import dockerfileTemplate from './lib/Dockerfile.hbs' with {type: 'text'}

describe.each([['ubuntu', '26.04'], ['ubuntu', '24.04'], ['debian', '13-slim'], ['debian', '12-slim'], ['archlinux', 'base-20260524.0.535294'], ['nixos/nix', '2.34.7']])('%s %s', (baseImage, baseImageVersion) => {
  beforeAll(async () => {
    // TODO Generate random SSH key
  })
  describe.each([['bun', '1.3.14'], ['deno', '2.8.0'], ['node', '26.2.0']])('%s runtime', (runtime, runtimeVersion) => {
    beforeAll(async () => {
      const handlebarsContext = {
        baseImage,
        baseImageVersion,
      }
      const dockerfileContent = renderHandlebars(dockerfileTemplate, handlebarsContext)
      // TODO Build image with all runtimes installed and start a container with an SSH server that accepts our temporary key
    })
    test('exec', async () => {
      // TODO Test `[runtimeName, '--version']`
    })
    describe.each(['hello', 'namedExports'])('%s script', scriptName => {
      test('run', async () => {
        // TODO Implement
      })
    })
  })
})
