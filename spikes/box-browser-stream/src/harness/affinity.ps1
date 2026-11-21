# Sets the processor affinity of each PID and all of its descendants. Windows children inherit their
# parent's affinity, so a browser pinned this way keeps new renderers on the same logical processors.
param([Parameter(Mandatory = $true)][string]$Pids, [Parameter(Mandatory = $true)][long]$Mask)

$ErrorActionPreference = 'SilentlyContinue'
$all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId
$children = @{}
foreach ($p in $all) {
  $parent = [int]$p.ParentProcessId
  if (-not $children.ContainsKey($parent)) { $children[$parent] = New-Object System.Collections.Generic.List[int] }
  $children[$parent].Add([int]$p.ProcessId)
}
$ids = New-Object System.Collections.Generic.HashSet[int]
$stack = New-Object System.Collections.Generic.Stack[int]
foreach ($root in $Pids.Split(',')) { $stack.Push([int]$root) }
while ($stack.Count -gt 0) {
  $id = $stack.Pop()
  if ($ids.Add($id) -and $children.ContainsKey($id)) { foreach ($c in $children[$id]) { $stack.Push($c) } }
}
$set = 0
foreach ($proc in (Get-Process -Id @($ids))) {
  $proc.ProcessorAffinity = [IntPtr]$Mask
  $set += 1
}
Write-Output "affinity $Mask set on $set processes"
