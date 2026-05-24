declare module 'serialize-javascript' {
  type SerializeJavascriptOptions = {
    ignoreFunction?: boolean
    isJSON?: boolean
    space?: number
    unsafe?: boolean
  }

  export default function serializeJavascript(value: unknown, options?: SerializeJavascriptOptions): string
}
