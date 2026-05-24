import serializeJavascript from 'serialize-javascript'

export const toJavaScriptLiteral = (value: unknown) => {
  return serializeJavascript(value)
}
