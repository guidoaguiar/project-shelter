# Shelter installer for Windows (Docker Desktop).
#
#   powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/guidoaguiar/project-shelter/main/install/install.ps1 | iex"
#
# With options:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/guidoaguiar/project-shelter/main/install/install.ps1))) -Lan
#
# Linux is the recommended host. On Windows, Shelter runs in Docker Desktop, which must be running.
# Rerun at any time to update; your data is kept.

param(
  [int]$Port = 0,
  [switch]$Lan,
  [switch]$Local,
  [string]$Dir = "",
  [switch]$Ai,
  [switch]$NoAi,
  [switch]$Yes,
  [string]$Branch = "main",
  [string]$Source = "",
  [switch]$Uninstall,
  [switch]$Help
)

# Not "Stop": on Windows PowerShell 5.1 that turns any stderr output from docker into a fatal error.
# Native commands are checked through $LASTEXITCODE; cmdlets that matter use -ErrorAction Stop.
$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is very slow with the progress bar on 5.1
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo = "guidoaguiar/project-shelter"
$DefaultPort = 4077
$AiModel = "llama3.2:3b"

function Step($m) { Write-Host ""; Write-Host "==> $m" -ForegroundColor Green }
function Info($m) { Write-Host "    $m" }
function Warn($m) { Write-Host "  ! $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host ""; Write-Host "  x $m" -ForegroundColor Red; Write-Host ""; throw "Shelter install stopped." }

function Ask($question, $default) {
  if ($Yes) { return ($default -eq "y") }
  $hint = if ($default -eq "y") { "[Y/n]" } else { "[y/N]" }
  $a = Read-Host "    $question $hint"
  if ([string]::IsNullOrWhiteSpace($a)) { $a = $default }
  return ($a -match '^[Yy]')
}
function AskValue($question, $default) {
  if ($Yes) { return "$default" }
  $a = Read-Host "    $question [$default]"
  if ([string]::IsNullOrWhiteSpace($a)) { return "$default" }
  return $a.Trim()
}

if ($Help) {
  @"
Shelter installer (Windows)

  -Port N      Port for the web interface (default $DefaultPort)
  -Lan         Serve phones and tablets on your network
  -Local       Serve this computer only (default)
  -Dir PATH    Install folder (default $HOME\Shelter)
  -Ai / -NoAi  Set up the local AI (Ollama + $AiModel, about 2.5 GB) or skip the question
  -Yes         Accept the defaults, ask nothing
  -Branch NAME Install from another branch (default main)
  -Source PATH Install from a local checkout instead of downloading
  -Uninstall   Remove Shelter (asks before deleting your data)
"@ | Write-Host
  return
}

if (-not [Environment]::Is64BitOperatingSystem) { Fail "Shelter needs 64-bit Windows 10 or 11." }

if ([string]::IsNullOrWhiteSpace($Dir)) { $Dir = Join-Path $HOME "Shelter" }
$Base = [IO.Path]::GetFullPath($Dir)
$App = Join-Path $Base "app"
$Data = Join-Path $Base "data"

function Have($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function DockerUp { if (-not (Have docker)) { return $false }; & docker info *> $null; return ($LASTEXITCODE -eq 0) }
function Compose { Push-Location $App; try { & docker compose @args; if ($LASTEXITCODE -ne 0) { throw "docker compose $args failed" } } finally { Pop-Location } }
function EnvGet($key, $file) {
  if (-not (Test-Path $file)) { return "" }
  $line = Get-Content $file | Where-Object { $_ -match "^$key=" } | Select-Object -Last 1
  if ($line) { return $line.Substring($key.Length + 1) } else { return "" }
}
function LanIp {
  try {
    $r = Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction Stop | Sort-Object { $_.RouteMetric + $_.InterfaceMetric } | Select-Object -First 1
    $ip = Get-NetIPAddress -InterfaceIndex $r.ifIndex -AddressFamily IPv4 -ErrorAction Stop | Select-Object -First 1
    return $ip.IPAddress
  } catch { return "" }
}

# ---------- uninstall ----------
if ($Uninstall) {
  Step "Removing Shelter"
  if ((Test-Path (Join-Path $App "compose.yaml")) -and (DockerUp)) {
    try { Compose down --rmi local } catch { Warn "Could not stop the Shelter container" }
  }
  if (DockerUp) {
    $ids = & docker ps -aq --filter label=shelter.service
    if ($ids -and (Ask "Also remove the services deployed from the Depot (their data folders are kept)?" "n")) { & docker rm -f $ids | Out-Null }
  }
  if (Test-Path $App) { Remove-Item -Recurse -Force $App }
  foreach ($lnk in @((Join-Path ([Environment]::GetFolderPath("Desktop")) "Shelter.url"), (Join-Path ([Environment]::GetFolderPath("Programs")) "Shelter.url"))) {
    if (Test-Path $lnk) { Remove-Item -Force $lnk }
  }
  if ((Test-Path $Data) -and (Ask "Delete your data in $Data (notes, stores, settings, downloaded content)? This cannot be undone." "n")) {
    Remove-Item -Recurse -Force $Data
  }
  if ((Test-Path $Base) -and -not (Get-ChildItem $Base -Force)) { Remove-Item $Base }
  Info "Shelter removed. Docker Desktop was left installed."
  if (Test-Path $Data) { Info "Your data is still in $Data" }
  return
}

# ---------- banner ----------
Write-Host ""
Write-Host "  SHELTER  offline-first survival knowledge node" -ForegroundColor White
Write-Host "  https://github.com/$Repo" -ForegroundColor DarkGray
Write-Host ""
Warn "Linux is the recommended host. Windows works through Docker Desktop, which must stay running."
Info "Install folder: $Base"

# ---------- docker ----------
Step "Checking Docker Desktop"
$dockerExe = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
if (-not (Have docker) -and -not (Test-Path $dockerExe)) {
  Info "Docker runs Shelter, its local AI and the Depot services."
  if ((Have winget) -and (Ask "Docker Desktop is not installed. Install it now? (Windows will ask for permission)" "y")) {
    & winget install -e --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { Fail "Docker Desktop did not install. Get it from https://www.docker.com/products/docker-desktop/ and run this again." }
    Warn "Docker Desktop is installed. If Windows asks you to restart, restart, open Docker Desktop once, then run this installer again."
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
  } else {
    Fail "Install Docker Desktop from https://www.docker.com/products/docker-desktop/, start it, then run this again."
  }
}
if (-not (DockerUp)) {
  Info "Starting Docker Desktop (the first start can take a few minutes)"
  if (Test-Path $dockerExe) { Start-Process $dockerExe }
  for ($i = 0; $i -lt 90; $i++) { if (DockerUp) { break }; Start-Sleep -Seconds 2 }
  if (-not (DockerUp)) { Fail "Docker did not start. Open Docker Desktop, accept its terms, wait until it says Engine running, then run this again." }
}
$serverOs = (& docker version --format "{{.Server.Os}}" 2>$null)
if ($serverOs -ne "linux") { Fail "Docker Desktop is in Windows containers mode. Right-click its tray icon, choose 'Switch to Linux containers', then run this again." }
& docker compose version *> $null
if ($LASTEXITCODE -ne 0) { Fail "Docker Compose v2 is required. Update Docker Desktop and run this again." }
Info ("Docker " + (& docker version --format "{{.Server.Version}}") + " is running")

# ---------- choices ----------
Step "Settings"
$prevEnv = Join-Path $App ".env"
if (Test-Path $prevEnv) { Info "Updating the existing install (previous settings are the defaults)" }
$prevPort = EnvGet "SHELTER_PORT" $prevEnv
$prevBind = EnvGet "SHELTER_BIND" $prevEnv

if ($Port -eq 0) {
  $d = if ($prevPort) { $prevPort } else { $DefaultPort }
  $Port = [int](AskValue "Port for the web interface?" $d)
}
if ($Port -lt 1 -or $Port -gt 65535) { Fail "Invalid port: $Port" }

$useLan = $false
if ($Lan) { $useLan = $true }
elseif (-not $Local) {
  Info "Other devices get the manual, map, tools and advisor. Notes, supplies and your plan need a PIN you choose next."
  $d = if ($prevBind -eq "0.0.0.0") { "y" } else { "n" }
  $useLan = Ask "Let phones and tablets on your network open Shelter?" $d
}
$bind = if ($useLan) { "0.0.0.0" } else { "127.0.0.1" }
if ($useLan) {
  Warn "On Docker Desktop, Shelter cannot tell this PC apart from other devices,"
  Warn "so Depot start/stop buttons are turned off in network mode. Linux does not have this limit."
}

# ---------- download ----------
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("shelter-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp -ErrorAction Stop | Out-Null
try {
  if ($Source) {
    Step "Copying Shelter from $Source"
    $src = Join-Path $tmp "src"
    New-Item -ItemType Directory -Path $src | Out-Null
    Get-ChildItem -Force $Source | Where-Object { @(".git", "data", "node_modules", ".env") -notcontains $_.Name } |
      Copy-Item -Destination $src -Recurse -Force -ErrorAction Stop
  } else {
    Step "Downloading Shelter ($Branch)"
    $zip = Join-Path $tmp "shelter.zip"
    try { Invoke-WebRequest -UseBasicParsing -Uri "https://codeload.github.com/$Repo/zip/refs/heads/$Branch" -OutFile $zip -ErrorAction Stop }
    catch { Fail "Download failed. Check your internet connection and the branch name." }
    Expand-Archive -Path $zip -DestinationPath (Join-Path $tmp "x") -Force -ErrorAction Stop
    $src = (Get-ChildItem (Join-Path $tmp "x") -Directory | Select-Object -First 1).FullName
  }
  if (-not $src -or -not (Test-Path (Join-Path $src "compose.yaml"))) { Fail "This does not look like Shelter (no compose.yaml)." }

  # Keep what the user added: custom Depot and kit entries, and new manual files. Edited built-in files are replaced.
  if (Test-Path $App) {
    foreach ($name in @("depot.custom.json", "kits.custom.json")) {
      $custom = Join-Path $App "config\$name"
      if (Test-Path $custom) { Copy-Item $custom (Join-Path $src "config\") -Force }
    }
    $oldManual = Join-Path $App "content\manual"
    if (Test-Path $oldManual) {
      Get-ChildItem $oldManual -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($oldManual.Length).TrimStart('\')
        $dest = Join-Path (Join-Path $src "content\manual") $rel
        if (-not (Test-Path $dest)) {
          New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
          Copy-Item $_.FullName $dest
        }
      }
    }
  }

  New-Item -ItemType Directory -Force -Path $Base, $Data -ErrorAction Stop | Out-Null
  if (Test-Path $App) { Remove-Item -Recurse -Force $App -ErrorAction Stop }
  Move-Item $src $App -ErrorAction Stop
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
Info "Files in $App"
Info "Data in  $Data"

# ---------- configure ----------
$dataFwd = $Data -replace '\\', '/'                 # C:/Users/you/Shelter/data
$drive = $Data.Substring(0, 1).ToLower()
$bindRoot = "/run/desktop/mnt/host/$drive" + ($Data.Substring(2) -replace '\\', '/') + "/depot"   # where the Docker VM sees it
$envText = @"
# Written by install/install.ps1 on $((Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")). Rerun the installer to change,
# or edit and apply with: docker compose up -d
COMPOSE_PROJECT_NAME=shelter
COMPOSE_PATH_SEPARATOR=:
COMPOSE_FILE=compose.yaml:compose.desktop.yaml
SHELTER_DATA_DIR=$dataFwd
SHELTER_DEPOT_HOST_DIR=$bindRoot
SHELTER_PORT=$Port
SHELTER_BIND=$bind
SHELTER_HOSTNAME=$env:COMPUTERNAME
SHELTER_HOST_LAN=$(LanIp)
SHELTER_REMOTE_ADMIN=0
"@
[IO.File]::WriteAllText((Join-Path $App ".env"), ($envText -replace "`r`n", "`n"))

# ---------- start ----------
Step "Building and starting Shelter"
Compose up -d --build --remove-orphans

Info "Waiting for Shelter to answer"
$up = $false
for ($i = 0; $i -lt 45; $i++) {
  try { Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/status" -TimeoutSec 3 -ErrorAction Stop | Out-Null; $up = $true; break } catch { Start-Sleep -Seconds 2 }
}
if (-not $up) { Fail "Shelter did not start. See the log with: cd `"$App`"; docker compose logs" }

# ---------- access PIN (network mode) ----------
# A new install keeps other devices read-only until a PIN is set. pin.js --setup does nothing when the
# node was configured before (an update), apart from reporting the current setting.
if ($useLan) {
  Step "Access for other devices"
  try {
    if ($Yes) { Compose exec -T shelter node server/pin.js --setup --open }
    else { Compose exec shelter node server/pin.js --setup }
  } catch {
    Warn "Could not set a PIN. Set one later with: docker exec -it shelter node server/pin.js"
  }
}

# ---------- shortcuts ----------
$url = "[InternetShortcut]`r`nURL=http://localhost:$Port/`r`nIconFile=$App\public\favicon.svg`r`n"
foreach ($folder in @([Environment]::GetFolderPath("Desktop"), [Environment]::GetFolderPath("Programs"))) {
  try { [IO.File]::WriteAllText((Join-Path $folder "Shelter.url"), $url) } catch { }
}
Info "Added a Shelter shortcut to the desktop and Start menu"

# ---------- local AI ----------
function OllamaUp { try { Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 2 -ErrorAction Stop | Out-Null; return $true } catch { return $false } }
$wantAi = $false
if (OllamaUp) {
  Step "Local AI"
  Info "Ollama is already running on this computer. The Advisor will use it."
} else {
  if ($Ai) { $wantAi = $true }
  elseif (-not $NoAi) {
    Step "Local AI"
    Info "The Advisor can answer questions using a model that runs on this computer."
    Info "This downloads Ollama and the $AiModel model (about 2.5 GB) and needs 8 GB of RAM."
    $wantAi = Ask "Set up the local AI now? (You can also do it later from the Depot.)" "y"
  }
}
if ($wantAi) {
  Step "Setting up the local AI"
  # Same name, label and folder the Depot uses, so the Depot shows it as deployed.
  $ollamaDir = Join-Path $Data "depot\ollama"
  New-Item -ItemType Directory -Force -Path $ollamaDir | Out-Null
  & docker inspect shelter-ollama *> $null
  if ($LASTEXITCODE -ne 0) {
    $gpu = @()
    if (Have nvidia-smi) { $gpu = @("--gpus", "all"); Info "Using the NVIDIA GPU" }
    & docker run -d --name shelter-ollama --label shelter.service=ollama --restart unless-stopped `
      -p "${bind}:11434:11434" --mount "type=bind,source=$ollamaDir,target=/root/.ollama" @gpu ollama/ollama:latest | Out-Null
    if ($LASTEXITCODE -ne 0 -and $gpu.Count) {
      Warn "GPU start failed, using the CPU instead"
      & docker rm -f shelter-ollama *> $null
      & docker run -d --name shelter-ollama --label shelter.service=ollama --restart unless-stopped `
        -p "${bind}:11434:11434" --mount "type=bind,source=$ollamaDir,target=/root/.ollama" ollama/ollama:latest | Out-Null
    }
  } else {
    & docker start shelter-ollama | Out-Null
  }
  for ($i = 0; $i -lt 30; $i++) { if (OllamaUp) { break }; Start-Sleep -Seconds 2 }
  Info "Downloading $AiModel (this is the long part)"
  & docker exec shelter-ollama ollama pull $AiModel
  if ($LASTEXITCODE -ne 0) { Warn "The model download failed. Retry later with: docker exec shelter-ollama ollama pull $AiModel" }
}

# ---------- done ----------
Step "Shelter is running"
Write-Host ""
Info "Open:  http://localhost:$Port   (or use the Shelter shortcut)"
if ($useLan) {
  $ip = LanIp
  if ($ip) { Info "From phones and tablets:  http://${ip}:$Port" }
  Info "If Windows Firewall asks about Docker, allow it on private networks."
}
Write-Host ""
Info "Shelter starts with Docker Desktop. In Docker Desktop settings, keep"
Info "'Start Docker Desktop when you sign in' turned on."
Info "Update: run this installer again. Logs: cd `"$App`"; docker compose logs"
Info "Back up your node by copying $Data"
Write-Host ""
