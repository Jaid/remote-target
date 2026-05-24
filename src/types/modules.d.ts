declare module '@babel/plugin-transform-react-jsx' {
  import type {PluginItem} from '@babel/core'

  const transformReactJsx: PluginItem

  export default transformReactJsx
}

declare module '@babel/plugin-transform-typescript' {
  import type {PluginItem} from '@babel/core'

  const transformTypeScript: PluginItem

  export default transformTypeScript
}
