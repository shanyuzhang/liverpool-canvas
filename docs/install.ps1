# Liverpool Canvas Assistant: one-step installer for Windows (PowerShell).
#
#   irm https://shanyuzhang.com/liverpool-canvas/install.ps1 | iex
#
# What it does, in order:
#   1. Uses Node.js 22+ if this computer already has it. Otherwise downloads the official
#      Node.js LTS from nodejs.org into %USERPROFILE%\.liverpool-canvas\node (no admin rights,
#      nothing installed system-wide) and checks its SHA-256 against nodejs.org's checksum list.
#   2. Checks that Edge or Chrome is installed (needed for the university sign-in window).
#   3. Starts Liverpool Canvas Assistant ({{PKG}}) from npm: setup the first time, a short
#      menu afterwards. Run the same command again any time.
# Source: https://github.com/shanyuzhang/liverpool-canvas
# (Plain ASCII on purpose: Windows PowerShell 5.1 reads downloaded scripts without a charset.)

& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

  $Pkg = '{{PKG}}'
  $Data = if ($env:LIVERPOOL_CANVAS_HOME) { $env:LIVERPOOL_CANVAS_HOME } else { Join-Path $HOME '.liverpool-canvas' }
  $Line = 'latest-v24.x'
  $Forward = @($args)

  Write-Host 'Liverpool Canvas Assistant'
  Write-Host ''

  # --- 1. Node.js -------------------------------------------------------------------------
  $haveNode = $false
  if (-not $env:LC_FORCE_NODE_DOWNLOAD -and (Get-Command node -ErrorAction SilentlyContinue)) {
    try { $haveNode = [int](& node -p "process.versions.node.split('.')[0]") -ge 22 } catch { $haveNode = $false }
  }
  if ($haveNode) {
    Write-Host ("OK  Node.js " + (& node -v))
  } else {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $sums = (Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$Line/SHASUMS256.txt").Content
    if ($sums -is [byte[]]) { $sums = [Text.Encoding]::ASCII.GetString($sums) }
    $m = [regex]::Match($sums, "(?m)^([0-9a-f]{64})\s+(node-v[0-9.]+-win-$arch)\.zip\s*$")
    if (-not $m.Success) { throw "No Node.js download found for win-$arch." }
    $sha = $m.Groups[1].Value
    $name = $m.Groups[2].Value
    $dest = Join-Path (Join-Path $Data 'node') $name
    if (-not (Test-Path (Join-Path $dest 'node.exe'))) {
      Write-Host 'Downloading Node.js (kept in your user folder, no admin rights needed)...'
      $tmp = Join-Path ([IO.Path]::GetTempPath()) ('lc-' + [guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory -Path $tmp | Out-Null
      try {
        $zip = Join-Path $tmp "$name.zip"
        Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$Line/$name.zip" -OutFile $zip
        $got = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLowerInvariant()
        if ($got -ne $sha) { throw 'The Node.js download did not match its checksum, so it was not used. Try again.' }
        Expand-Archive -Path $zip -DestinationPath $tmp -Force
        New-Item -ItemType Directory -Force -Path (Join-Path $Data 'node') | Out-Null
        if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
        Move-Item -Path (Join-Path $tmp $name) -Destination $dest
      } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
      }
    }
    $env:PATH = "$dest;$env:PATH"
    Write-Host ("OK  Node.js " + (& (Join-Path $dest 'node.exe') -v) + " ($dest)")
  }

  # --- 2. Edge or Chrome ------------------------------------------------------------------
  $candidates = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  $browser = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if ($browser) {
    Write-Host "OK  $browser"
  } elseif ($Forward.Count -eq 0) {
    Write-Host ''
    Write-Host 'Microsoft Edge or Google Chrome is needed for the university sign-in.'
    Write-Host 'Install Chrome from https://www.google.com/chrome/ and run the same command again.'
    return
  }
  Write-Host ''

  # --- 3. Start ---------------------------------------------------------------------------
  & npx.cmd -y "$Pkg@latest" @Forward
} @args
