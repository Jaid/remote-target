import type {NormalizedRunInput, RunInput} from './types.ts'
import type {NodePath, PluginObject} from '@babel/core'

import {createRequire} from 'node:module'

import {toJavaScriptLiteral} from './toJavaScriptLiteral.ts'

const moduleRequire = createRequire(import.meta.url)
const {transformAsync, types: t} = moduleRequire('@babel/core') as typeof import('@babel/core')
const parserPlugins = ['decorators-legacy', 'jsx', 'typescript'] as const
const transformReactJsxPluginName = '@babel/plugin-transform-react-jsx'
const transformTypeScriptPluginName = '@babel/plugin-transform-typescript'
const largeSourceCompactThreshold = 500_000
const getExportedName = (node: {name?: string
  value?: unknown}) => {
  if (typeof node.name === 'string') {
    return node.name
  }
  if (typeof node.value === 'string') {
    return node.value
  }
  throw new Error('Unsupported exported name.')
}
const isTopLevelReturnStatement = (path: NodePath) => {
  return path.isReturnStatement() && !path.getFunctionParent()
}
const createExportAssignment = (exportsKey: string, exportedName: string, expression: Parameters<typeof t.assignmentExpression>[2]) => {
  return t.expressionStatement(t.assignmentExpression('=', t.memberExpression(t.memberExpression(t.identifier('globalThis'), t.stringLiteral(exportsKey), true), t.stringLiteral(exportedName), true), expression))
}
const createExportBinding = (exportsKey: string, exportedName: string, expression: Parameters<typeof t.arrowFunctionExpression>[1]) => {
  return t.expressionStatement(t.callExpression(t.memberExpression(t.identifier('Object'), t.identifier('defineProperty')), [
    t.memberExpression(t.identifier('globalThis'), t.stringLiteral(exportsKey), true),
    t.stringLiteral(exportedName),
    t.objectExpression([
      t.objectProperty(t.identifier('enumerable'), t.booleanLiteral(true)),
      t.objectProperty(t.identifier('get'), t.arrowFunctionExpression([], expression)),
    ]),
  ]))
}
const createNormalizationPlugin = (options: {
  exportsKey: string
  forceReturnValue: boolean
  returnValueKey: string
  state: {hasReturnValue: boolean}
}) => {
  return (): PluginObject => ({
    name: 'remote-target-normalization',
    visitor: {
      Program(programPath) {
        const imports: Array<typeof programPath.node.body[number]> = []
        const executableBody: Array<typeof programPath.node.body[number]> = []
        let hasModuleSyntax = false
        for (const statement of programPath.node.body) {
          if (t.isImportDeclaration(statement)) {
            hasModuleSyntax = true
            imports.push(statement)
            continue
          }
          if (t.isExportDefaultDeclaration(statement)) {
            hasModuleSyntax = true
            const declaration = statement.declaration
            if ((t.isFunctionDeclaration(declaration) || t.isClassDeclaration(declaration)) && declaration.id) {
              executableBody.push(declaration)
              executableBody.push(createExportAssignment(options.exportsKey, 'default', t.identifier(declaration.id.name)))
            } else if (t.isFunctionDeclaration(declaration)) {
              const expression = t.functionExpression(null, declaration.params, declaration.body, declaration.generator, declaration.async)
              executableBody.push(createExportAssignment(options.exportsKey, 'default', expression))
            } else if (t.isClassDeclaration(declaration)) {
              const expression = t.classExpression(null, declaration.superClass, declaration.body, declaration.decorators ?? [])
              executableBody.push(createExportAssignment(options.exportsKey, 'default', expression))
            } else if (t.isExpression(declaration)) {
              const expression = declaration
              executableBody.push(createExportAssignment(options.exportsKey, 'default', expression))
            } else {
              executableBody.push(declaration)
            }
            continue
          }
          if (t.isExportAllDeclaration(statement)) {
            hasModuleSyntax = true
            const importedNamespace = t.awaitExpression(t.importExpression(t.cloneNode(statement.source)))
            executableBody.push(t.expressionStatement(t.callExpression(t.memberExpression(t.identifier('Object'), t.identifier('assign')), [t.memberExpression(t.identifier('globalThis'), t.stringLiteral(options.exportsKey), true), importedNamespace])))
            continue
          }
          if (t.isExportNamedDeclaration(statement)) {
            hasModuleSyntax = true
            if (statement.declaration) {
              if (t.isTSInterfaceDeclaration(statement.declaration) || t.isTSTypeAliasDeclaration(statement.declaration) || t.isTSDeclareFunction(statement.declaration)) {
                continue
              }
              executableBody.push(statement.declaration)
              for (const [name, identifier] of Object.entries(t.getBindingIdentifiers(statement.declaration))) {
                executableBody.push(createExportBinding(options.exportsKey, name, t.cloneNode(identifier)))
              }
              continue
            }
            if (statement.source) {
              const namespaceIdentifier = programPath.scope.generateUidIdentifier('remoteTargetModule')
              executableBody.push(t.variableDeclaration('const', [t.variableDeclarator(namespaceIdentifier, t.awaitExpression(t.importExpression(t.cloneNode(statement.source))))]))
              for (const specifier of statement.specifiers) {
                if (statement.exportKind === 'type') {
                  continue
                }
                if (t.isExportNamespaceSpecifier(specifier)) {
                  executableBody.push(createExportBinding(options.exportsKey, getExportedName(specifier.exported), t.cloneNode(namespaceIdentifier)))
                } else if (t.isExportSpecifier(specifier) && specifier.exportKind !== 'type') {
                  executableBody.push(createExportBinding(options.exportsKey, getExportedName(specifier.exported), t.memberExpression(t.cloneNode(namespaceIdentifier), t.stringLiteral(getExportedName(specifier.local)), true)))
                }
              }
              continue
            }
            for (const specifier of statement.specifiers) {
              if (t.isExportSpecifier(specifier) && statement.exportKind !== 'type' && specifier.exportKind !== 'type') {
                executableBody.push(createExportBinding(options.exportsKey, getExportedName(specifier.exported), t.cloneNode(specifier.local)))
              }
            }
            continue
          }
          executableBody.push(statement)
        }
        const probeProgram = t.program(executableBody.map(statement => t.cloneNode(statement, true)))
        let hasExplicitReturn = false
        programPath.traverse({
          ReturnStatement(returnPath) {
            if (isTopLevelReturnStatement(returnPath)) {
              hasExplicitReturn = true
            }
          },
        })
        options.state.hasReturnValue = options.forceReturnValue || hasExplicitReturn
        if (!options.state.hasReturnValue && !hasModuleSyntax) {
          const lastStatement = executableBody.at(-1)
          if (lastStatement && t.isExpressionStatement(lastStatement)) {
            executableBody[executableBody.length - 1] = t.returnStatement(lastStatement.expression)
            options.state.hasReturnValue = true
          }
        }
        const asyncBody = t.blockStatement(executableBody)
        const invocation = t.awaitExpression(t.callExpression(t.arrowFunctionExpression([], asyncBody, true), []))
        const invocationStatement = options.state.hasReturnValue ? t.expressionStatement(t.assignmentExpression('=', t.memberExpression(t.identifier('globalThis'), t.stringLiteral(options.returnValueKey), true), invocation)) : t.expressionStatement(invocation)
        programPath.node.body = [
          ...imports,
          t.expressionStatement(t.assignmentExpression('=', t.memberExpression(t.identifier('globalThis'), t.stringLiteral(options.exportsKey), true), t.objectExpression([]))),
          invocationStatement,
        ]
        // The cloned program forces Babel to validate the rewritten body before later transforms.
        void probeProgram
      },
    },
  })
}

export const normalizeRunInput = async (input: RunInput): Promise<NormalizedRunInput> => {
  const inputCode = typeof input === 'function' ? input.toString() : input
  const uniqueId = crypto.randomUUID().replaceAll('-', '')
  const returnValueKey = `__remoteTargetReturnValue_${uniqueId}`
  const exportsKey = `__remoteTargetExports_${uniqueId}`
  const jsxFactoryName = `__remoteTargetJsx_${uniqueId}`
  const jsxFragmentName = `__remoteTargetFragment_${uniqueId}`
  const jsxPrelude = `const ${jsxFragmentName} = Symbol.for('remote-target.fragment')
const ${jsxFactoryName} = (type, props, ...children) => {
  const normalizedChildren = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
  return {props: {...(props || {}), ...(normalizedChildren === undefined ? {} : {children: normalizedChildren})}, type}
}`
  const source = typeof input === 'function' ? `return await (${inputCode})()` : inputCode
  const rewrittenSource = `${jsxPrelude}\n${source}`
  const rewriteState = {hasReturnValue: false}
  const transformed = await transformAsync(rewrittenSource, {
    babelrc: false,
    compact: Buffer.byteLength(rewrittenSource, 'utf8') > largeSourceCompactThreshold ? true : undefined,
    configFile: false,
    filename: 'remote-target-input.tsx',
    parserOpts: {
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      plugins: [...parserPlugins],
    },
    plugins: [
      createNormalizationPlugin({
        exportsKey,
        forceReturnValue: typeof input === 'function',
        returnValueKey,
        state: rewriteState,
      }),
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
    exportsKey,
    hasReturnValue: rewriteState.hasReturnValue,
    inputCode,
    normalizedCode: transformed.code,
    returnValueKey,
  }
}
