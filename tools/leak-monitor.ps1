# Samples StreamDeck.exe memory and the set of running plugins, every 15s, to a CSV.
#
# The host process is found by name each tick, so it survives an app restart (new PID).
# Recording which plugin node processes are alive lets us correlate a change in the
# memory-growth slope with exactly which plugin was disabled.

param(
    [string]$LogPath = (Join-Path $env:TEMP 'sd_leak_monitor.csv'),
    [int]$IntervalSeconds = 15,
    [int]$DurationMinutes = 120
)

if (-not (Test-Path $LogPath)) {
    'epoch,iso,sd_pid,sd_ws_mb,sd_private_mb,handles,threads,family_ws_mb,plugin_count,plugins' |
        Out-File -Encoding utf8 $LogPath
}

$pluginRx = [regex]'\\Plugins\\([^\\]+)\.sdPlugin\\'
$deadline = (Get-Date).AddMinutes($DurationMinutes)

while ((Get-Date) -lt $deadline) {
    $now = Get-Date
    $epoch = [datetimeoffset]::UtcNow.ToUnixTimeSeconds()

    # The main host process — the one that leaks. Take the largest by working set in case
    # more than one StreamDeck.exe exists.
    $sd = Get-Process StreamDeck -ErrorAction SilentlyContinue | Sort-Object WS -Descending | Select-Object -First 1

    # Sum of the whole Stream Deck family (host + Qt renderers + audio helpers), in case
    # the growth ever shows up in a renderer rather than the host.
    $familyWs = 0
    Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match 'StreamDeck|QtWebEngine|Elgato' } |
        ForEach-Object { $familyWs += $_.WS }
    $familyWsMb = [math]::Round($familyWs / 1MB)

    # Which plugins are currently running, by UUID (leading "com." trimmed for width).
    # Match against every process, not just node.exe: many plugins are compiled .NET/C++
    # executables (BarRaider, Discord, Current Media), and the UUID appears in their exe
    # path rather than in a command-line argument. Checking both catches every kind.
    $plugins = @()
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {
        $m = $pluginRx.Match("$($_.CommandLine) $($_.ExecutablePath)")
        if ($m.Success) { $plugins += ($m.Groups[1].Value -replace '^com\.', '') }
    }
    $plist = ($plugins | Sort-Object -Unique) -join ';'

    if ($sd) {
        $line = '{0},{1},{2},{3},{4},{5},{6},{7},{8},{9}' -f `
            $epoch, $now.ToString('o'), $sd.Id, [math]::Round($sd.WS / 1MB), `
            [math]::Round($sd.PrivateMemorySize64 / 1MB), $sd.HandleCount, $sd.Threads.Count, `
            $familyWsMb, $plugins.Count, $plist
    }
    else {
        # Host not up yet (e.g. mid-restart); record the gap so the timeline stays honest.
        $line = '{0},{1},,,,,,{2},{3},{4}' -f $epoch, $now.ToString('o'), $familyWsMb, $plugins.Count, $plist
    }

    Add-Content -Path $LogPath -Value $line
    Start-Sleep -Seconds $IntervalSeconds
}
