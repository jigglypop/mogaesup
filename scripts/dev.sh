#!/usr/bin/env bash
# macOS/Linux counterpart of scripts/dev.ps1: PostgreSQL (docker compose), the Rust server and the web app, and with
# `character` the character server (backend/) on 127.0.0.1:8016 behind the server's studio gateway.
#   scripts/dev.sh              server and web
#   scripts/dev.sh character    the character server too
#   scripts/dev.sh stop         ends what this script started
# Logs and PIDs go to .data/dev/. A service already listening on its port is kept as it is. POSTGRES_PORT overrides
# 55432 when another process holds it. backend/.env holds production keys and is read here, never printed. The
# character server starts with auto-resume off and its records in mogaesup_character on the compose PostgreSQL;
# admins may change studio records (FACTORY_ACCESS=write) and paid studio work stays blocked. The server gets
# backend/.env's OPENAI_API_KEY for 사주 readings and pictures, but its month's budget of paid calls is none (the page
# asks for both by itself): READINGS_MONTHLY=3 PICTURES_MONTHLY=1 in front of the command allows that many.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
logs="$root/.data/dev"
mkdir -p "$logs"

# A process's start time tells it from a later one that got the same PID. ps writes it in the caller's locale, so
# one locale is asked for: a stop from another terminal reads the same words a start wrote.
started() { LC_ALL=C ps -o lstart= -p "$1" 2>/dev/null | xargs; }

if [[ "${1:-}" == "stop" ]]; then
  for name in character server web; do
    pidfile="$logs/$name.pid"
    [[ -f "$pidfile" ]] || continue
    read -r pid since <"$pidfile" || true
    now="$(started "$pid")"
    if [[ -z "$now" ]]; then
      echo "$name ($pid) is not running"
    elif [[ -z "$since" || "$now" != "$since" ]]; then
      echo "$name: pid $pid is not the process this script started; left running"
    else
      # The PID leads its own process group, so npm's vite and uv's uvicorn end with it.
      kill -- "-$pid" 2>/dev/null && echo "stopped $name ($pid)"
    fi
    rm -f "$pidfile"
  done
  exit 0
fi
character=false
[[ "${1:-}" == "character" ]] && character=true

# Whether something answers on the port: bash's own connection, so no tool has to be installed for it.
listening() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# start <name> <dir> <command...>: runs the command detached as the leader of its own process group (job control
# gives a background job one), with its output in the log, so nothing of it holds the caller's terminal or pipe.
start() {
  local name="$1" dir="$2"
  shift 2
  set -m
  (cd "$dir" && exec nohup "$@") >"$logs/$name.log" 2>&1 </dev/null &
  set +m
  echo "$! $(started $!)" >"$logs/$name.pid"
}

# A secret kept per machine outside git (server/data/ is ignored), made on first use.
local_secret() {
  local file="$root/server/data/local/$1.txt"
  if [[ ! -f "$file" ]]; then
    mkdir -p "$(dirname "$file")"
    head -c 36 /dev/urandom | base64 | tr -d '\n' >"$file"
  fi
  cat "$file"
}

# The value of KEY in backend/.env, without its quotes; empty when the file is missing or does not set it.
factory_env() {
  [[ -r "$root/backend/.env" ]] || return 0
  sed -n -E "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*(.*)$/\1/p" "$root/backend/.env" 2>/dev/null | tail -n 1 |
    sed -E "s/[[:space:]]+$//; s/^\"(.*)\"$/\1/; s/^'(.*)'$/\1/"
}

pg_port="${POSTGRES_PORT:-55432}"
pg_password="${POSTGRES_PASSWORD:-postgres-dev}"
(cd "$root/server" && POSTGRES_PORT="$pg_port" docker compose up -d --wait postgres)

server_env=(
  DATABASE_URL="postgres://postgres:$pg_password@127.0.0.1:$pg_port/mogaesup"
  REALTIME_TICKET_SECRET="${REALTIME_TICKET_SECRET:-$(local_secret realtime-ticket-secret)}"
  LISTEN_ADDR=127.0.0.1:8080
  APP_ORIGIN=http://127.0.0.1:5180,http://localhost:5180
  COOKIE_SECURE=false
  MODEL_STORE="$root/server/data/local/models"
  RUST_LOG="${RUST_LOG:-info}"
  READINGS_MONTHLY="${READINGS_MONTHLY:-0}"
  PICTURES_MONTHLY="${PICTURES_MONTHLY:-0}"
)
openai_key="$(factory_env OPENAI_API_KEY)"
[[ -z "$openai_key" ]] || server_env+=(OPENAI_API_KEY="$openai_key")

if $character; then
  # The gateway signs its requests with the secret the character server checks them with. A machine whose
  # backend/.env has none gets one of its own, handed to both.
  jwt_secret="$(factory_env JWT_SECRET)"
  [[ -n "$jwt_secret" ]] || jwt_secret="$(local_secret factory-jwt-secret)"
  if listening 8016; then
    echo "character: 8016 already listening"
  else
    records="postgresql://postgres:$pg_password@127.0.0.1:$pg_port/mogaesup_character"
    prefix="$(factory_env ASSET_S3_PREFIX)"
    (cd "$root" && CHARACTER_DATABASE_URL="$records" uv run python -m src.records migrate --create-database)
    # A prefix whose records were never imported is refused; status names the import command.
    (cd "$root" && CHARACTER_DATABASE_URL="$records" uv run python -m src.records status --prefix "${prefix:-assets}") || true
    # Stages a previous run left unfinished are not resumed by a dev start: that would be paid work nobody asked for.
    start character "$root" env ASSET_AUTO_RESUME=0 CHARACTER_DATABASE_URL="$records" JWT_SECRET="$jwt_secret" \
      uv run python -m uvicorn src.api.server:app --host 127.0.0.1 --port 8016
  fi
  server_env+=(FACTORY_URL=http://127.0.0.1:8016 FACTORY_JWT_SECRET="$jwt_secret" FACTORY_ACCESS=write FACTORY_PAID_MONTHLY=0)
  for pair in FACTORY_API_KEY:API_KEY FACTORY_JWT_ISSUER:JWT_ISSUER FACTORY_JWT_AUDIENCE:JWT_AUDIENCE; do
    value="$(factory_env "${pair#*:}")"
    [[ -z "$value" ]] || server_env+=("${pair%%:*}=$value")
  done
fi

if listening 8080; then
  echo "server: 8080 already listening"
else
  (cd "$root/server" && cargo build)
  # Runs a copy of the build, so cargo can rebuild and test while this server runs.
  bin="$root/server/data/local/bin"
  mkdir -p "$bin"
  cp "$root/server/target/debug/mogaesup-server" "$bin/mogaesup-server"
  start server "$root/server" env "${server_env[@]}" "$bin/mogaesup-server"
fi

if listening 5180; then
  echo "web: 5180 already listening"
else
  start web "$root" npm run dev -w frontend
fi

checks=(http://127.0.0.1:8080/api/health http://127.0.0.1:5180/)
if $character; then checks=(http://127.0.0.1:8016/health "${checks[@]}"); fi
for url in "${checks[@]}"; do
  for _ in $(seq 60); do curl -fsS -o /dev/null "$url" 2>/dev/null && break; sleep 1; done
  curl -fsS -o /dev/null "$url" 2>/dev/null && echo "up: $url" || echo "not up: $url (see $logs)"
done
