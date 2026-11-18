#!/usr/bin/env bash
# Shelter installer for Linux (recommended) and macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/guidoaguiar/project-shelter/main/install/install.sh -o install.sh
#   sudo bash install.sh          # Linux
#   bash install.sh               # macOS (no sudo)
#
# Installs Docker if needed, downloads Shelter, and runs it as a container that
# restarts on boot. Rerun it at any time to update; your data is kept.
# Run with --help for options.

set -euo pipefail

REPO="guidoaguiar/project-shelter"
BRANCH="main"
DEFAULT_PORT=4077
AI_MODEL="llama3.2:3b"

# ---------- output ----------
if [[ -t 1 ]]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; D=$'\e[2m'; N=$'\e[0m'; else B= G= Y= R= D= N=; fi
step() { printf '\n%s==>%s %s%s%s\n' "$G" "$N" "$B" "$*" "$N"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '%s  ! %s%s\n' "$Y" "$*" "$N" >&2; }
die()  { printf '\n%s  x %s%s\n\n' "$R" "$*" "$N" >&2; exit 1; }

usage() {
  cat <<EOF
Shelter installer (Linux, macOS)

Usage: install.sh [options]

  --port N        Port for the web interface (default $DEFAULT_PORT)
  --lan           Serve phones and tablets on your network
  --local         Serve this machine only (default)
  --dir PATH      Install folder (default /opt/shelter on Linux, ~/Shelter on macOS)
  --ai | --no-ai  Set up the local AI (Ollama + $AI_MODEL, about 2.5 GB) or skip the question
  --yes           Accept the defaults, ask nothing
  --branch NAME   Install from another branch (default $BRANCH)
  --source PATH   Install from a local checkout instead of downloading
  --uninstall     Remove Shelter (asks before deleting your data)
  -h, --help      Show this help

Rerun the installer to update. Your data and settings are kept.
EOF
}

# ---------- options ----------
PORT="" LAN="" BASE="" AI="" SOURCE="" ASSUME_YES=0 UNINSTALL=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="${2:-}"; shift 2 ;;
    --lan) LAN=1; shift ;;
    --local) LAN=0; shift ;;
    --dir) BASE="${2:-}"; shift 2 ;;
    --ai) AI=1; shift ;;
    --no-ai) AI=0; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --source) SOURCE="${2:-}"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "Unknown option: $1" ;;
  esac
done
[[ -z "$PORT" || "$PORT" =~ ^[0-9]+$ && "$PORT" -ge 1 && "$PORT" -le 65535 ]] || die "--port must be a number from 1 to 65535"

# Prompts read the terminal directly, so `curl ... | bash` still works interactively.
HAS_TTY=0; { exec 3</dev/tty; } 2>/dev/null && HAS_TTY=1
ask() { # ask "Question" y|n  -> exit status 0 means yes
  local q="$1" def="$2" hint ans
  if [[ $ASSUME_YES == 1 || $HAS_TTY == 0 ]]; then [[ $def == y ]]; return; fi
  [[ $def == y ]] && hint="[Y/n]" || hint="[y/N]"
  read -r -u 3 -p "    $q $hint " ans || ans=""
  ans="${ans:-$def}"
  [[ $ans =~ ^[Yy] ]]
}
ask_value() { # ask_value "Question" default -> prints answer
  local q="$1" def="$2" ans
  if [[ $ASSUME_YES == 1 || $HAS_TTY == 0 ]]; then printf '%s' "$def"; return; fi
  read -r -u 3 -p "    $q [$def] " ans || ans=""
  printf '%s' "${ans:-$def}"
}

# ---------- platform ----------
OS="$(uname -s)"
case "$OS" in
  Linux) PLATFORM=linux ;;
  Darwin) PLATFORM=mac ;;
  *) die "Unsupported system: $OS. On Windows use install/install.ps1." ;;
esac

if [[ $PLATFORM == linux ]]; then
  [[ $EUID -eq 0 ]] || die "Run with sudo:  sudo bash $0 $*"
  BASE="${BASE:-/opt/shelter}"
  OWNER="${SUDO_USER:-root}"
else
  [[ $EUID -ne 0 ]] || die "On macOS run without sudo:  bash $0"
  BASE="${BASE:-$HOME/Shelter}"
  OWNER="$(id -un)"
fi
APP="$BASE/app"
DATA="$BASE/data"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

need_cmd() { command -v "$1" >/dev/null 2>&1; }

pkg_install() { # best effort across Linux distributions
  if need_cmd apt-get; then apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
  elif need_cmd dnf; then dnf install -y -q "$@"
  elif need_cmd yum; then yum install -y -q "$@"
  elif need_cmd pacman; then pacman -Sy --noconfirm --needed "$@"
  elif need_cmd zypper; then zypper --non-interactive install "$@"
  elif need_cmd apk; then apk add --no-cache "$@"
  else return 1; fi
}

lan_ip() {
  local ip=""
  if [[ $PLATFORM == mac ]]; then
    ip="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
  else
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}' || true)"
    [[ -n "$ip" ]] || ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  fi
  printf '%s' "$ip"
}

env_get() { # env_get KEY file -> value from a previous install
  [[ -f "$2" ]] && sed -n "s/^$1=//p" "$2" | tail -n1 || true
}

compose() { (cd "$APP" && docker compose "$@"); }

# ---------- uninstall ----------
if [[ $UNINSTALL == 1 ]]; then
  step "Removing Shelter"
  if [[ -f "$APP/compose.yaml" ]] && need_cmd docker; then
    compose down --rmi local || warn "Could not stop the Shelter container"
  fi
  if need_cmd docker && [[ -n "$(docker ps -aq --filter label=shelter.service 2>/dev/null)" ]]; then
    if ask "Also remove the services deployed from the Depot (their data folders are kept)?" n; then
      docker rm -f $(docker ps -aq --filter label=shelter.service) >/dev/null
    fi
  fi
  rm -rf "$APP" "$BASE/shelter"
  [[ -L /usr/local/bin/shelter ]] && rm -f /usr/local/bin/shelter
  if [[ -d "$DATA" ]] && ask "Delete your data in $DATA (notes, stores, settings, downloaded content)? This cannot be undone." n; then
    rm -rf "$DATA"
  fi
  rmdir "$BASE" 2>/dev/null || true
  info "Shelter removed. Docker itself was left installed."
  [[ -d "$DATA" ]] && info "Your data is still in $DATA"
  exit 0
fi

# ---------- banner ----------
cat <<EOF

${B}  SHELTER${N}  offline-first survival knowledge node
  ${D}https://github.com/$REPO${N}

EOF
if [[ $PLATFORM == mac ]]; then
  warn "Linux is the recommended host. macOS works through Docker Desktop, which must stay running."
fi
info "Install folder: $BASE"

# ---------- prerequisites ----------
step "Checking prerequisites"
for c in curl tar; do
  if ! need_cmd "$c"; then
    [[ $PLATFORM == linux ]] && pkg_install "$c" >/dev/null || die "$c is required. Install it and run this again."
  fi
done
info "curl and tar found"

# ---------- docker ----------
step "Checking Docker"
if [[ $PLATFORM == linux ]]; then
  if ! need_cmd docker; then
    info "Docker runs Shelter, its local AI and the Depot services."
    ask "Docker is not installed. Install it now?" y || die "Docker is required. See https://docs.docker.com/engine/install/"
    if need_cmd pacman; then
      pacman -Sy --noconfirm --needed docker docker-compose
    else
      curl -fsSL https://get.docker.com -o "$TMP/get-docker.sh"
      sh "$TMP/get-docker.sh"
    fi
  fi
  if need_cmd systemctl; then systemctl enable --now docker >/dev/null 2>&1 || true; fi
  if ! docker info >/dev/null 2>&1; then
    # Systems without systemd (some containers, older distros)
    if need_cmd service; then service docker start >/dev/null 2>&1 || true
    elif [[ -x /etc/init.d/docker ]]; then /etc/init.d/docker start >/dev/null 2>&1 || true; fi
    for _ in $(seq 1 15); do docker info >/dev/null 2>&1 && break; sleep 1; done
  fi
  docker info >/dev/null 2>&1 || die "Docker is installed but not running. Start it (sudo systemctl start docker) and run this again."
  if ! docker compose version >/dev/null 2>&1; then
    info "Installing the Docker Compose plugin"
    pkg_install docker-compose-plugin >/dev/null 2>&1 || pkg_install docker-compose >/dev/null 2>&1 || true
    docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required. See https://docs.docker.com/compose/install/linux/"
  fi
else
  if ! need_cmd docker; then
    if need_cmd brew && ask "Docker Desktop is not installed. Install it with Homebrew now?" y; then
      brew install --cask docker
    else
      die "Install Docker Desktop from https://www.docker.com/products/docker-desktop/ (or OrbStack), start it, then run this again."
    fi
  fi
  if ! docker info >/dev/null 2>&1; then
    info "Starting Docker Desktop (the first start can take a minute)"
    open -a Docker 2>/dev/null || open -a OrbStack 2>/dev/null || true
    for _ in $(seq 1 90); do docker info >/dev/null 2>&1 && break; sleep 2; done
    docker info >/dev/null 2>&1 || die "Docker did not start. Open Docker Desktop, wait until it says it is running, then run this again."
  fi
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required. Update Docker Desktop and run this again."
fi
info "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null) is running"

# ---------- choices ----------
step "Settings"
PREV_ENV="$APP/.env"
[[ -f "$PREV_ENV" ]] && info "Updating the existing install (previous settings are the defaults)"
PREV_PORT="$(env_get SHELTER_PORT "$PREV_ENV")"
PREV_BIND="$(env_get SHELTER_BIND "$PREV_ENV")"

[[ -n "$PORT" ]] || PORT="$(ask_value "Port for the web interface?" "${PREV_PORT:-$DEFAULT_PORT}")"
[[ "$PORT" =~ ^[0-9]+$ && "$PORT" -ge 1 && "$PORT" -le 65535 ]] || die "Invalid port: $PORT"

if [[ -z "$LAN" ]]; then
  info "Shelter has no login. Only allow your network if you trust everyone on it."
  if ask "Let phones and tablets on your network open Shelter?" "$([[ $PREV_BIND == 0.0.0.0 ]] && echo y || echo n)"; then LAN=1; else LAN=0; fi
fi
BIND="127.0.0.1"; [[ $LAN == 1 ]] && BIND="0.0.0.0"

REMOTE_ADMIN=0
if [[ $LAN == 1 && $PLATFORM == mac ]]; then
  # Docker Desktop hides client addresses, so Shelter cannot tell this Mac from a phone.
  warn "On Docker Desktop, Shelter cannot tell this Mac apart from other devices,"
  warn "so Depot start/stop buttons are turned off in network mode. Linux does not have this limit."
fi

# ---------- download ----------
mkdir -p "$TMP/src"
if [[ -n "$SOURCE" ]]; then
  step "Copying Shelter from $SOURCE"
  (cd "$SOURCE" && tar -cf - --exclude=./.git --exclude=./data --exclude=./node_modules --exclude=./.env .) | tar -xf - -C "$TMP/src"
else
  step "Downloading Shelter ($BRANCH)"
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" -o "$TMP/shelter.tar.gz" \
    || die "Download failed. Check your internet connection and the branch name."
  tar -xzf "$TMP/shelter.tar.gz" -C "$TMP/src" --strip-components=1
fi
[[ -f "$TMP/src/compose.yaml" && -f "$TMP/src/server.js" ]] || die "This does not look like Shelter (no compose.yaml)."

# Keep what the user added: custom Depot entries and new manual files. Edited built-in files are replaced.
if [[ -d "$APP" ]]; then
  [[ -f "$APP/config/depot.custom.json" ]] && cp -p "$APP/config/depot.custom.json" "$TMP/src/config/"
  if [[ -d "$APP/content/manual" ]]; then
    (cd "$APP/content/manual" && find . -type f) | while IFS= read -r f; do
      if [[ ! -e "$TMP/src/content/manual/$f" ]]; then
        mkdir -p "$(dirname "$TMP/src/content/manual/$f")"
        cp -p "$APP/content/manual/$f" "$TMP/src/content/manual/$f"
      fi
    done
  fi
fi

mkdir -p "$BASE" "$DATA"
rm -rf "$APP.new"
mv "$TMP/src" "$APP.new"
rm -rf "$APP.old"
[[ -d "$APP" ]] && mv "$APP" "$APP.old"
mv "$APP.new" "$APP"
rm -rf "$APP.old"
info "Files in $APP"
info "Data in  $DATA"

# ---------- configure ----------
if [[ $PLATFORM == linux ]]; then
  COMPOSE_FILES="compose.yaml:compose.host.yaml"
  HOST_LAN=""
else
  COMPOSE_FILES="compose.yaml:compose.desktop.yaml"
  HOST_LAN="$(lan_ip)"
fi

cat > "$APP/.env" <<EOF
# Written by install/install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Rerun the installer to change,
# or edit and apply with: docker compose up -d
COMPOSE_PROJECT_NAME=shelter
COMPOSE_PATH_SEPARATOR=:
COMPOSE_FILE=$COMPOSE_FILES
SHELTER_DATA_DIR=$DATA
SHELTER_PORT=$PORT
SHELTER_BIND=$BIND
SHELTER_HOSTNAME=$(hostname -s 2>/dev/null || hostname)
SHELTER_HOST_LAN=$HOST_LAN
SHELTER_REMOTE_ADMIN=$REMOTE_ADMIN
EOF

if [[ $PLATFORM == mac ]]; then chown -R "$OWNER" "$BASE" 2>/dev/null || true; fi

# ---------- start ----------
step "Building and starting Shelter"
compose up -d --build --remove-orphans

info "Waiting for Shelter to answer"
UP=0
for _ in $(seq 1 45); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/status" 2>/dev/null; then UP=1; break; fi
  sleep 2
done
[[ $UP == 1 ]] || die "Shelter did not start. See the log with: cd $APP && docker compose logs"

# ---------- firewall (Linux, network mode) ----------
if [[ $PLATFORM == linux && $LAN == 1 ]]; then
  if need_cmd ufw && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow "$PORT/tcp" comment "Shelter" >/dev/null && info "Opened port $PORT in ufw"
  elif need_cmd firewall-cmd && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port="$PORT/tcp" >/dev/null && firewall-cmd --reload >/dev/null && info "Opened port $PORT in firewalld"
  fi
fi

# ---------- helper command ----------
HELPER="$BASE/shelter"
cat > "$HELPER" <<EOF
#!/usr/bin/env bash
# Shelter helper, written by the installer.
set -e
cd "$APP"
case "\${1:-}" in
  start)   docker compose up -d ;;
  stop)    docker compose stop ;;
  restart) docker compose restart ;;
  status)  docker compose ps; docker ps --filter label=shelter.service --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' ;;
  logs)    docker compose logs -f --tail 100 ;;
  update)  curl -fsSL https://raw.githubusercontent.com/$REPO/$BRANCH/install/install.sh -o /tmp/shelter-install.sh && bash /tmp/shelter-install.sh --yes --dir "$BASE" ;;
  open)    url="http://localhost:$PORT"; (xdg-open "\$url" || open "\$url") >/dev/null 2>&1 || echo "\$url" ;;
  *) echo "Usage: shelter start|stop|restart|status|logs|update|open"; exit 1 ;;
esac
EOF
chmod +x "$HELPER"
if [[ $PLATFORM == linux ]]; then
  mkdir -p /usr/local/bin && ln -sf "$HELPER" /usr/local/bin/shelter
  HELPER_CMD="sudo shelter"
else
  HELPER_CMD="$HELPER"
fi

# ---------- local AI ----------
ollama_running() { curl -fsS -o /dev/null "http://127.0.0.1:11434/api/tags" 2>/dev/null; }
if ollama_running; then
  step "Local AI"
  info "Ollama is already running on this machine. The Advisor will use it."
else
  if [[ -z "$AI" ]]; then
    step "Local AI"
    info "The Advisor can answer questions using a model that runs on this machine."
    info "This downloads Ollama and the $AI_MODEL model (about 2.5 GB) and needs 8 GB of RAM."
    if ask "Set up the local AI now? (You can also do it later from the Depot.)" y; then AI=1; else AI=0; fi
  fi
  if [[ $AI == 1 ]]; then
    step "Setting up the local AI"
    # Same name, label and folder the Depot uses, so the Depot shows it as deployed.
    mkdir -p "$DATA/depot/ollama"
    GPU=()
    if need_cmd nvidia-smi && docker info 2>/dev/null | grep -qi nvidia; then GPU=(--gpus all); info "Using the NVIDIA GPU"; fi
    if ! docker inspect shelter-ollama >/dev/null 2>&1; then
      docker run -d --name shelter-ollama --label shelter.service=ollama --restart unless-stopped \
        -p "$BIND:11434:11434" --mount "type=bind,source=$DATA/depot/ollama,target=/root/.ollama" \
        ${GPU[@]+"${GPU[@]}"} ollama/ollama:latest >/dev/null
    else
      docker start shelter-ollama >/dev/null
    fi
    for _ in $(seq 1 30); do ollama_running && break; sleep 2; done
    info "Downloading $AI_MODEL (this is the long part)"
    docker exec shelter-ollama ollama pull "$AI_MODEL" || warn "The model download failed. Retry later with: docker exec shelter-ollama ollama pull $AI_MODEL"
  fi
fi

# ---------- done ----------
step "Shelter is running"
echo
info "${B}Open:${N}  http://localhost:$PORT"
if [[ $LAN == 1 ]]; then
  ip="$(lan_ip)"; [[ -n "$ip" ]] && info "${B}From phones and tablets:${N}  http://$ip:$PORT"
fi
echo
info "It starts by itself when this computer boots."
[[ $PLATFORM == mac ]] && info "Docker Desktop must be running: enable 'Start Docker Desktop when you sign in' in its settings."
info "Manage it with:  $HELPER_CMD status | logs | stop | start | update"
info "Back up your node by copying $DATA"
echo
