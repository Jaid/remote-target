import type {Linter} from 'eslint'

import {makeEslintConfig} from 'eslint-config-jaid'

export default [
  {
    ignores: ['private/**'],
  },
  ...makeEslintConfig(),
] as Array<Linter.Config>
