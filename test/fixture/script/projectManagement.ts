const runtimeContexts = {
  async node() {
    const childProcess = await import('child_process')
    const exec = async (cwd: string, command: Array<string>) => {
      const output = await childProcess.exec(command.join(' '), {cwd})
      return output.stdout
    }
    return {exec}
  },
  async bun() {
    const exec = async (cwd: string, command: Array<string>) => {
      const execution = Bun.spawn(command, {cwd})
      await execution.exited
      const output = await execution.stdout.text()
      return output
    }
    return {exec}
  },
  async deno() {
    const childProcess = await import('node:child_process')
    const exec = async (cwd: string, command: Array<string>) => {
      const output = await childProcess.exec(command.join(' '), {cwd})
      return output.stdout
    }
    return {exec}
  }
}

const packageManagers = {
  npm() {
    const getInstallCommand = (name: string) => ['npm', 'install', '--save-dev', name]
    return {getInstallCommand}
  },
  bun() {
    const getInstallCommand = (name: string) => ['bun', 'add', '--dev', name]
    return {getInstallCommand}
  },
  deno() {
    const getInstallCommand = (name: string) => ['deno', 'add', '--dev', `npm:${name}`]
    return {getInstallCommand}
  }
}

const runtimeContext = await runtimeContexts[guessRuntime()]()

const results = new Map<keyof typeof packageManagers, {swcKeys: Set<string>, bytes: number}>

for (const packageManagerName of Object.keys(packageManagers)) {
  const packageManager = packageManagers[packageManagerName]()
  const folder = `/tmp/${crypto.randomUUID()}`
  await runtimeContext.exec(`mkdir -p ${folder}`)
  await runtimeContext.exec(packageManager.getInstallCommand('@swc/core').join(' '), {
    cwd: folder
  })
  const swc = await import(`${folder}/node_modules/@swc/core/index.js`)
  const bytesResult = await runtimeContext.exec(`du -sb ${folder}`)
  const bytes = Number.parseInt(bytesResult.toString().split(/\D+/)[0])
  results.set(packageManagerName, {
    swcKeys: new Set(Object.keys(swc)),
    bytes
  })
}

return results
