import type {NormalizedRunInput, RunInput} from './types.ts'
import type {NodePath, PluginObj} from '@babel/core'

import {createRequire} from 'node:module'

import {toJavaScriptLiteral} from './toJavaScriptLiteral.ts'

const moduleRequire = createRequire(import.meta.url)
const {transformAsync, types: t} = moduleRequire('@babel/core') as typeof import('@babel/core')
const parserPlugins = ['decorators-legacy', 'importAttributes', 'jsx', 'typescript'] as const
const transformReactJsxPluginName = '@babel/plugin-transform-react-jsx'
const transformTypeScriptPluginName = '@babel/plugin-transform-typescript'
const jsxFactoryName = '__remoteTargetJsx'
const jsxFragmentName = '__remoteTargetFragment'
const jsxPrelude = `const ${jsxFragmentName} = Symbol.for('remote-target.fragment')
const ${jsxFactoryName} = (type, props, ...children) => {
  const normalizedChildren = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
  return {
    props: {
      ...(props || {}),
      ...(normalizedChildren === undefined ? {} : {children: normalizedChildren}),
    },
    type,
  }
}`
const createReturnValueExpression = (returnValueKey: string, expression?: Parameters<typeof t.assignmentExpression>[2]) => {
  return t.assignmentExpression('=', t.memberExpression(t.identifier('globalThis'), t.stringLiteral(returnValueKey), true), expression ?? t.unaryExpression('void', t.numericLiteral(0), true))
}
const isTopLevelReturnStatement = (path: NodePath) => {
  return path.isReturnStatement() && !path.getFunctionParent()
}
const hasModuleSyntax = (programPath: NodePath) => {
  return programPath.isProgram() && programPath.node.body.some(statement => {
    return t.isImportDeclaration(statement) || t.isExportAllDeclaration(statement) || t.isExportDefaultDeclaration(statement) || t.isExportNamedDeclaration(statement)
  })
}
const createReturnValuePlugin = (returnValueKey: string, state: {hasReturnValue: boolean}): PluginObj => {
  return {
    name: 'remote-target-return-value',
    visitor: {
      Program(programPath) {
        const explicitReturnState = {
          value: false,
        }
        programPath.traverse({
          ReturnStatement(path) {
            if (!isTopLevelReturnStatement(path)) {
              return
            }
            explicitReturnState.value = true
            state.hasReturnValue = true
            path.replaceWith(t.expressionStatement(createReturnValueExpression(returnValueKey, path.node.argument ? t.cloneNode(path.node.argument, true) : undefined)))
            path.skip()
          },
        })
        if (explicitReturnState.value || hasModuleSyntax(programPath)) {
          return
        }
        const lastExpressionStatementPath = [...programPath.get('body')].toReversed().find(statementPath => {
          return statementPath.isExpressionStatement()
        })
        if (!lastExpressionStatementPath) {
          return
        }
        state.hasReturnValue = true
        lastExpressionStatementPath.replaceWith(t.expressionStatement(createReturnValueExpression(returnValueKey, t.cloneNode(lastExpressionStatementPath.node.expression, true))))
      },
    },
  }
}
const normalizeFunctionInput = (inputCode: string, returnValueKey: string) => {
  return {
    code: `globalThis[${toJavaScriptLiteral(returnValueKey)}] = await (${inputCode})()
export default globalThis[${toJavaScriptLiteral(returnValueKey)}]`,
    hasReturnValue: true,
  }
}

export const normalizeRunInput = async (input: RunInput): Promise<NormalizedRunInput> => {
  const inputCode = typeof input === 'function' ? input.toString() : input
  const returnValueKey = `__remoteTargetReturnValue_${crypto.randomUUID()}`
  const rewrittenSource = typeof input === 'function' ? normalizeFunctionInput(inputCode, returnValueKey) : {
    code: inputCode,
    hasReturnValue: false,
  }
  const rewriteState = {
    hasReturnValue: rewrittenSource.hasReturnValue,
  }
  const transformed = await transformAsync(`${jsxPrelude}
${rewrittenSource.code}`, {
    babelrc: false,
    configFile: false,
    filename: 'remote-target-input.tsx',
    parserOpts: {
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      plugins: [...parserPlugins],
    },
    plugins: [
      createReturnValuePlugin(returnValueKey, rewriteState),
      [
        transformTypeScriptPluginName, {
          allExtensions: true,
          allowDeclareFields: true,
          allowNamespaces: true,
          isTSX: true,
          jsxPragma: jsxFactoryName,
          jsxPragmaFrag: jsxFragmentName,
          onlyRemoveTypeImports: false,
          optimizeConstEnums: true,
        },
      ],
      [
        transformReactJsxPluginName, {
          pragma: jsxFactoryName,
          pragmaFrag: jsxFragmentName,
          runtime: 'classic',
        },
      ],
    ],
    sourceMaps: false,
    sourceType: 'module',
  })
  if (!transformed?.code) {
    throw new Error('Babel did not return transformed code.')
  }
  return {
    hasReturnValue: rewriteState.hasReturnValue,
    inputCode,
    normalizedCode: transformed.code,
    returnValueKey,
  }
}
