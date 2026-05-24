import type {NormalizedRunInput, RunInput} from './types.ts'

import {parse} from '@babel/parser'
import {transform} from '@swc/core'

type AstNode = {
  [key: string]: unknown
  end: number
  start: number
  type: string
}

type SourceReplacement = {
  end: number
  start: number
  text: string
}

const parserPlugins = ['decorators-legacy', 'importAttributes', 'jsx', 'typescript'] as const
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
function applyReplacements(source: string, replacements: Array<SourceReplacement>) {
  let normalizedSource = source
  for (const replacement of replacements.toSorted((left, right) => right.start - left.start)) {
    normalizedSource = `${normalizedSource.slice(0, replacement.start)}${replacement.text}${normalizedSource.slice(replacement.end)}`
  }
  return normalizedSource
}
function getAstNode(value: unknown): AstNode | undefined {
  if (!value || typeof value !== 'object') {
    return
  }
  if (!Object.hasOwn(value, 'type') || !Object.hasOwn(value, 'start') || !Object.hasOwn(value, 'end')) {
    return
  }
  const candidate = value as Record<string, unknown>
  const {end, start, type} = candidate
  if (typeof type !== 'string' || typeof start !== 'number' || typeof end !== 'number') {
    return
  }
  return value as AstNode
}
function getAstNodes(value: unknown): Array<AstNode> {
  if (!Array.isArray(value)) {
    return []
  }
  return value.map(item => getAstNode(item)).filter((item): item is AstNode => item !== undefined)
}
function hasModuleSyntax(statements: Array<AstNode>) {
  return statements.some(statement => statement.type.startsWith('Export') || statement.type.startsWith('Import'))
}
function isFunctionLikeNode(node: AstNode | undefined) {
  return node ? node.type === 'ArrowFunctionExpression' || node.type === 'ClassMethod' || node.type === 'ClassPrivateMethod' || node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ObjectMethod' : false
}
function walkTopLevelStatements(statement: AstNode, visitReturn: (statement: AstNode) => void): void {
  if (statement.type === 'ReturnStatement') {
    visitReturn(statement)
    return
  }
  if (statement.type === 'BlockStatement') {
    for (const blockStatement of getAstNodes(statement.body)) {
      walkTopLevelStatements(blockStatement, visitReturn)
    }
    return
  }
  if (statement.type === 'DoWhileStatement' || statement.type === 'ForInStatement' || statement.type === 'ForOfStatement' || statement.type === 'ForStatement' || statement.type === 'LabeledStatement' || statement.type === 'WhileStatement' || statement.type === 'WithStatement') {
    const body = getAstNode(statement.body)
    if (body) {
      walkTopLevelStatements(body, visitReturn)
    }
    return
  }
  if (statement.type === 'IfStatement') {
    const consequent = getAstNode(statement.consequent)
    if (consequent) {
      walkTopLevelStatements(consequent, visitReturn)
    }
    const alternate = getAstNode(statement.alternate)
    if (alternate) {
      walkTopLevelStatements(alternate, visitReturn)
    }
    return
  }
  if (statement.type === 'SwitchStatement') {
    for (const switchCase of getAstNodes(statement.cases)) {
      for (const consequent of getAstNodes(switchCase.consequent)) {
        walkTopLevelStatements(consequent, visitReturn)
      }
    }
    return
  }
  if (statement.type === 'TryStatement') {
    const block = getAstNode(statement.block)
    if (block) {
      walkTopLevelStatements(block, visitReturn)
    }
    const handler = getAstNode(statement.handler)
    const handlerBody = handler ? getAstNode(handler.body) : undefined
    if (handlerBody) {
      walkTopLevelStatements(handlerBody, visitReturn)
    }
    const finalizer = getAstNode(statement.finalizer)
    if (finalizer) {
      walkTopLevelStatements(finalizer, visitReturn)
    }
    return
  }
  if (statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration') {
    const declaration = getAstNode(statement.declaration)
    if (declaration && !isFunctionLikeNode(declaration) && declaration.type !== 'ClassDeclaration') {
      walkTopLevelStatements(declaration, visitReturn)
    }
  }
}
function rewriteSourceForReturnValue(code: string, returnValueKey: string) {
  const parsed = parse(code, {
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    plugins: [...parserPlugins],
    sourceType: 'module',
  }) as {program?: {body?: unknown}}
  const statements = getAstNodes(parsed.program?.body)
  const replacements: Array<SourceReplacement> = []
  let hasReturnValue = false
  for (const statement of statements) {
    walkTopLevelStatements(statement, returnStatement => {
      const argument = getAstNode(returnStatement.argument)
      hasReturnValue = true
      if (argument) {
        replacements.push({
          end: argument.start,
          start: returnStatement.start,
          text: `globalThis[${JSON.stringify(returnValueKey)}] = `,
        })
        return
      }
      replacements.push({
        end: returnStatement.end,
        start: returnStatement.start,
        text: `globalThis[${JSON.stringify(returnValueKey)}] = undefined`,
      })
    })
  }
  const hasExplicitReturnValue = replacements.length > 0
  if (!hasExplicitReturnValue && !hasModuleSyntax(statements)) {
    const expressionStatementIndex = statements.findLastIndex(statement => statement.type === 'ExpressionStatement')
    const expressionStatement = expressionStatementIndex === -1 ? undefined : statements[expressionStatementIndex]
    if (expressionStatement) {
      const expression = getAstNode(expressionStatement.expression)
      if (expression) {
        hasReturnValue = true
        replacements.push({
          end: expressionStatement.end,
          start: expressionStatement.start,
          text: `globalThis[${JSON.stringify(returnValueKey)}] = (${code.slice(expression.start, expression.end)})`,
        })
      }
    }
  }
  return {
    code: applyReplacements(code, replacements),
    hasReturnValue,
  }
}

export const normalizeRunInput = async (input: RunInput): Promise<NormalizedRunInput> => {
  const inputCode = typeof input === 'function' ? input.toString() : input
  const returnValueKey = `__remoteTargetReturnValue_${crypto.randomUUID()}`
  const rewrittenSource = typeof input === 'function' ? {
    code: `globalThis[${JSON.stringify(returnValueKey)}] = await (${inputCode})()
export default globalThis[${JSON.stringify(returnValueKey)}]`,
    hasReturnValue: true,
  } : rewriteSourceForReturnValue(inputCode, returnValueKey)
  const transformed = await transform(`${jsxPrelude}
${rewrittenSource.code}`, {
    filename: 'remote-target-input.tsx',
    jsc: {
      parser: {
        decorators: true,
        dynamicImport: true,
        syntax: 'typescript',
        tsx: true,
      },
      target: 'es2022',
      transform: {
        react: {
          pragma: jsxFactoryName,
          pragmaFrag: jsxFragmentName,
          runtime: 'classic',
        },
      },
    },
    module: {
      type: 'es6',
    },
    sourceMaps: false,
  })
  return {
    hasReturnValue: rewrittenSource.hasReturnValue,
    inputCode,
    normalizedCode: transformed.code,
    returnValueKey,
  }
}
