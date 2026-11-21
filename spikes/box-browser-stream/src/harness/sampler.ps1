# Samples CPU time and memory of named process groups once a second, as JSON lines on stdout.
# -Groups "name=pid,pid;other=!pid": a group is its PIDs and every descendant; a PID written as !pid counts
# that process alone (the sidecar, whose child is the browser, counted as its own group).
param([Parameter(Mandatory = $true)][string]$Groups, [int]$IntervalMs = 1000)

$ErrorActionPreference = 'SilentlyContinue'
$spec = @{}
foreach ($entry in $Groups.Split(';')) {
  $parts = $entry.Split('=')
  $spec[$parts[0]] = $parts[1].Split(',')
}

while ($true) {
  $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId
  $children = @{}
  foreach ($p in $all) {
    $parent = [int]$p.ParentProcessId
    if (-not $children.ContainsKey($parent)) { $children[$parent] = New-Object System.Collections.Generic.List[int] }
    $children[$parent].Add([int]$p.ProcessId)
  }
  $groupsOut = @{}
  foreach ($name in $spec.Keys) {
    $ids = New-Object System.Collections.Generic.HashSet[int]
    $stack = New-Object System.Collections.Generic.Stack[int]
    foreach ($root in $spec[$name]) {
      if ($root.StartsWith('!')) { [void]$ids.Add([int]$root.Substring(1)) } else { $stack.Push([int]$root) }
    }
    while ($stack.Count -gt 0) {
      $id = $stack.Pop()
      if ($ids.Add($id) -and $children.ContainsKey($id)) { foreach ($c in $children[$id]) { $stack.Push($c) } }
    }
    $procs = @()
    if ($ids.Count -gt 0) {
      foreach ($proc in (Get-Process -Id @($ids))) {
        $procs += @{ id = $proc.Id; cpu = $proc.TotalProcessorTime.TotalSeconds; ws = $proc.WorkingSet64; priv = $proc.PrivateMemorySize64 }
      }
    }
    $groupsOut[$name] = $procs
  }
  @{ t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); groups = $groupsOut } | ConvertTo-Json -Compress -Depth 5
  Start-Sleep -Milliseconds $IntervalMs
}
