const taskPath = String.raw`\remote-target`
// Runs inside the desktop session as a scheduled task. It owns the actual child process and mirrors its streams into files the relay tails.
const desktopScript = String.raw`
$ErrorActionPreference = 'Stop'
# The headless console starts with the OEM code page; children inherit this one instead, matching the SSH session.
[Console]::InputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$lines = (Get-Content -Raw -LiteralPath "$PSScriptRoot\spec") -split [char]10
$relayPid = [int]$lines[0]
$relayStart = [long]$lines[1]
$taskName = $lines[2]
$argv = @($lines[3] -split ',' | ForEach-Object {[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_))})
$code = 1
$orphaned = $false
$share = [IO.FileShare]'ReadWrite, Delete'
$stdoutFile = [IO.FileStream]::new("$PSScriptRoot\stdout", 'Open', 'Write', $share)
$stderrFile = [IO.FileStream]::new("$PSScriptRoot\stderr", 'Open', 'Write', $share)
try {
  New-Item -ItemType File -Path "$PSScriptRoot\started" | Out-Null
  $info = [Diagnostics.ProcessStartInfo]::new($argv[0])
  for ($index = 1; $index -lt $argv.Count; $index++) {
    $info.ArgumentList.Add($argv[$index])
  }
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.WorkingDirectory = $PWD.ProviderPath
  $process = [Diagnostics.Process]::Start($info)
  $copies = [Threading.Tasks.Task[]]@($process.StandardOutput.BaseStream.CopyToAsync($stdoutFile), $process.StandardError.BaseStream.CopyToAsync($stderrFile))
  $stdinFile = [IO.File]::OpenRead("$PSScriptRoot\stdin")
  $feed = $stdinFile.CopyToAsync($process.StandardInput.BaseStream)
  $fed = $false
  while (-not $process.HasExited) {
    if (-not $fed -and $feed.IsCompleted) {
      $fed = $true
      try {
        $process.StandardInput.Close()
      } catch {}
    }
    $relay = Get-Process -Id $relayPid -ErrorAction SilentlyContinue
    $relayAlive = $null -ne $relay
    if ($relayAlive) {
      try {
        $relayAlive = $relay.StartTime.ToFileTimeUtc() -eq $relayStart
      } catch {}
    }
    if (-not $relayAlive) {
      # The SSH side is gone, so nobody can receive the output anymore.
      $orphaned = $true
      $process.Kill($true)
      break
    }
    Start-Sleep -Milliseconds 50
  }
  $process.WaitForExit()
  $stdinFile.Dispose()
  # Descendants can inherit the output pipes, so draining them is bounded.
  $null = [Threading.Tasks.Task]::WaitAll($copies, 1000)
  $code = $process.ExitCode
} catch {
  $message = [Text.Encoding]::UTF8.GetBytes("$_" + [char]10)
  $stderrFile.Write($message, 0, $message.Length)
} finally {
  $stdoutFile.Dispose()
  $stderrFile.Dispose()
  Set-Content -LiteralPath "$PSScriptRoot\exit.tmp" -Value $code -NoNewline
  Move-Item -LiteralPath "$PSScriptRoot\exit.tmp" -Destination "$PSScriptRoot\exit"
  if ($orphaned) {
    Remove-Item -LiteralPath $PSScriptRoot -Recurse -Force -ErrorAction SilentlyContinue
    try {
      $service = New-Object -ComObject Schedule.Service
      $service.Connect()
      $service.GetFolder('${taskPath}').DeleteTask($taskName, 0)
    } catch {}
  }
}
`
// Runs in the SSH session. When that session is non-interactive (session 0) and the same user is logged in on a desktop, it hands the command to a scheduled task with an interactive principal and streams the result back.
const relayScript = (encodedArgv: string, fallback: string) => String.raw`
$ProgressPreference = 'SilentlyContinue'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$self = Get-Process -Id $PID
$hasDesktop = $false
if ($IsWindows -and $self.SessionId -eq 0) {
  # Opening a process with full access succeeds for the user's own processes, so this finds the user's desktop shells without querying owners through CIM.
  $hasDesktop = @([Diagnostics.Process]::GetProcessesByName('explorer') | Where-Object {
    if ($_.SessionId -eq 0) {
      return $false
    }
    try {
      $null = $_.Handle
      return $true
    } catch {
      return $false
    }
  }).Count -gt 0
}
if (-not $hasDesktop) {
  ${fallback}
}
$id = [guid]::NewGuid().ToString('N')
$taskName = "remote-target-$id"
$directory = Join-Path ([IO.Path]::GetTempPath()) $taskName
New-Item -ItemType Directory -Path $directory | Out-Null
$code = 1
try {
  $stdinFile = [IO.File]::Create("$directory\stdin")
  try {
    [Console]::OpenStandardInput().CopyTo($stdinFile)
  } finally {
    $stdinFile.Dispose()
  }
  [IO.File]::WriteAllBytes("$directory\stdout", [byte[]]@())
  [IO.File]::WriteAllBytes("$directory\stderr", [byte[]]@())
  Set-Content -LiteralPath "$directory\spec" -NoNewline -Value (@($PID, $self.StartTime.ToFileTimeUtc(), $taskName, '${encodedArgv}') -join [char]10)
  Set-Content -LiteralPath "$directory\desktop.ps1" -Value $desktopScript
  $quote = [char]34
  $argument = '--headless ' + $quote + $self.Path + $quote + ' -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + $quote + "$directory\desktop.ps1" + $quote
  # The COM API is several times faster than the ScheduledTasks module, which matters since every invocation registers a task.
  $service = New-Object -ComObject Schedule.Service
  $service.Connect()
  try {
    $folder = $service.GetFolder('${taskPath}')
  } catch {
    try {
      $null = $service.GetFolder('\').CreateFolder('${taskPath}')
    } catch {}
    $folder = $service.GetFolder('${taskPath}')
  }
  # A killed relay cannot delete its task, and an unelevated desktop process may not be allowed to either. Every relay keeps its directory until it deleted its task, so a task without one is stale.
  foreach ($staleTask in @($folder.GetTasks(1))) {
    if ($staleTask.State -ne 4 -and -not (Test-Path -LiteralPath (Join-Path ([IO.Path]::GetTempPath()) $staleTask.Name))) {
      try {
        $folder.DeleteTask($staleTask.Name, 0)
      } catch {}
    }
  }
  $definition = $service.NewTask(0)
  $definition.Principal.UserId = $identity.Name
  $definition.Principal.LogonType = 3 # TASK_LOGON_INTERACTIVE_TOKEN
  $definition.Principal.RunLevel = 0 # TASK_RUNLEVEL_LUA
  $definition.Settings.DisallowStartIfOnBatteries = $false
  $definition.Settings.StopIfGoingOnBatteries = $false
  $definition.Settings.ExecutionTimeLimit = 'PT0S'
  $definition.Settings.MultipleInstances = 0 # TASK_INSTANCES_PARALLEL
  $definition.Settings.Hidden = $true
  $action = $definition.Actions.Create(0) # TASK_ACTION_EXEC
  $action.Path = "$env:SystemRoot\System32\conhost.exe"
  $action.Arguments = $argument
  $action.WorkingDirectory = $PWD.ProviderPath
  $task = $folder.RegisterTaskDefinition($taskName, $definition, 6, $null, $null, 3) # TASK_CREATE_OR_UPDATE, TASK_LOGON_INTERACTIVE_TOKEN
  $null = $task.Run($null)
  $share = [IO.FileShare]'ReadWrite, Delete'
  $pipes = @(
    @([IO.FileStream]::new("$directory\stdout", 'Open', 'Read', $share), [Console]::OpenStandardOutput()),
    @([IO.FileStream]::new("$directory\stderr", 'Open', 'Read', $share), [Console]::OpenStandardError())
  )
  $buffer = [byte[]]::new(65536)
  $pump = {
    foreach ($pipe in $pipes) {
      while (($count = $pipe[0].Read($buffer, 0, $buffer.Length)) -gt 0) {
        $pipe[1].Write($buffer, 0, $count)
      }
      $pipe[1].Flush()
    }
  }
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $nextCheck = 1000
  while ($true) {
    . $pump
    if (Test-Path -LiteralPath "$directory\exit") {
      . $pump
      $code = [int](Get-Content -Raw -LiteralPath "$directory\exit")
      break
    }
    if ($clock.ElapsedMilliseconds -ge $nextCheck) {
      $nextCheck += 1000
      $started = Test-Path -LiteralPath "$directory\started"
      if (-not $started -and $clock.ElapsedMilliseconds -ge 15000) {
        throw 'The desktop session did not start the command within 15 seconds.'
      }
      if ($started -and $task.State -ne 4 -and -not (Test-Path -LiteralPath "$directory\exit")) { # TASK_STATE_RUNNING
        throw 'The desktop session task ended without reporting an exit code.'
      }
    }
    Start-Sleep -Milliseconds 10
  }
  foreach ($pipe in $pipes) {
    $pipe[0].Dispose()
  }
} catch {
  [Console]::Error.WriteLine("remote-target: $_")
} finally {
  if ($folder) {
    try {
      $folder.DeleteTask($taskName, 0)
    } catch {}
  }
  Remove-Item -LiteralPath $directory -Recurse -Force -ErrorAction SilentlyContinue
}
exit $code
`
const encodeArgv = (command: Array<string>) => command.map(argument => Buffer.from(argument).toBase64()).join(',')

/**
 * Builds PowerShell source that runs `command` in the interactive desktop session of the SSH user when the SSH session itself is not interactive.
 * @param command the argv to run
 * @param fallback PowerShell statements that run the command directly and exit, used when no desktop session is available
 */
export const buildDesktopRelay = (command: Array<string>, fallback: string) => {
  return `$desktopScript = @'\n${desktopScript.trim()}\n'@\n${relayScript(encodeArgv(command), fallback)}`
}
