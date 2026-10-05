#!/usr/bin/env bash
set -Eeuo pipefail

release_key="${1:?release key is required}"
release_sha="${2:?release sha256 is required}"
source_root="${3:?extracted release directory is required}"
config_file=/etc/asset-studio.env
service_name=gaesup-asset-studio
rollback_name=gaesup-asset-studio-rollback
expected_source="/opt/asset-studio/incoming/$release_sha/source"
# The admission token of a deployment that may have left admission closed (see save_token).
token_file=/opt/asset-studio/drain-token

[[ "$release_key" =~ ^releases/studio/[0-9a-f]{64}\.tar\.gz$ ]] || { echo 'invalid release key' >&2; exit 2; }
[[ "$release_sha" =~ ^[0-9a-f]{64}$ ]] || { echo 'invalid release sha256' >&2; exit 2; }
[[ "$release_key" == "releases/studio/$release_sha.tar.gz" ]] || { echo 'release key and sha256 do not match' >&2; exit 2; }
[[ "$source_root" == "$expected_source" ]] || { echo 'unexpected release source path' >&2; exit 2; }
[[ -f "$config_file" ]] || { echo "$config_file is missing" >&2; exit 2; }
[[ -f "$source_root/infra/Dockerfile" ]] || { echo 'release is missing infra/Dockerfile' >&2; exit 2; }
grep -qx "$release_sha" "$source_root/.release-sha256" || { echo 'release archive hash was not verified' >&2; exit 2; }

# This file contains resource identifiers, not provider secret values.
# shellcheck disable=SC1090
source "$config_file"
: "${ASSET_S3_BUCKET:?ASSET_S3_BUCKET is required}"
: "${AWS_REGION:?AWS_REGION is required}"
: "${PROVIDER_SECRET_ARN:?PROVIDER_SECRET_ARN is required}"
[[ "$AWS_REGION" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]+$ ]] || { echo 'invalid AWS_REGION' >&2; exit 2; }
PUBLIC_STUDIO="${PUBLIC_STUDIO:-false}"

# deploy-aws.ps1 passes the end of its SSM execution timeout (epoch seconds). That timeout kills this script without its
# EXIT trap, so admission is closed only while draining, replacing and a rollback all still fit before it.
deploy_deadline="${ASSET_DEPLOY_DEADLINE:-}"
[[ -z "$deploy_deadline" || "$deploy_deadline" =~ ^[0-9]+$ ]] || { echo 'invalid ASSET_DEPLOY_DEADLINE' >&2; exit 2; }
budget_left() { if [[ -n "$deploy_deadline" ]]; then echo $(( deploy_deadline - $(date +%s) )); else echo 86400; fi; }
# What the deployment needs once the old runtime is idle (stop, candidate start and health, a rollback), and what a
# rollback alone needs (restore and reopen the previous runtime).
replace_seconds=240
rollback_seconds=120

exec 9>/var/lock/asset-studio-deploy.lock
flock -n 9 || { echo 'another deployment is active' >&2; exit 3; }

install -d -m 700 /opt/asset-studio /opt/asset-studio/releases /opt/asset-studio/scratch
# nginx's logs, on the host so infra/idle-stop.sh sees the last request even while no container runs.
install -d -m 755 /var/log/asset-studio
secret_tmp="$(mktemp /opt/asset-studio/provider.json.XXXXXX)"
# The configuration the running release started with, kept from just before the new one is installed until the new
# release is committed. A deployment that was killed (the SSM timeout skips the EXIT trap) leaves it for the next one to
# put back (recover_interrupted below).
provider_previous=/opt/asset-studio/provider.previous.json
provider_backup=false
provider_installed=false
provider_committed=false
restore_provider() {
  if [[ "$provider_installed" == true && "$provider_committed" != true ]]; then
    if [[ "$provider_backup" == true && -f "$provider_previous" ]]; then
      mv -f "$provider_previous" /opt/asset-studio/provider.json
      provider_backup=false
    else
      rm -f /opt/asset-studio/provider.json
    fi
    provider_installed=false
  fi
}
gateway_header=''
cleanup_files() {
  restore_provider
  [[ -z "$secret_tmp" ]] || rm -f "$secret_tmp"
  [[ -z "$gateway_header" ]] || rm -f "$gateway_header"
  # Only a copy this run made: one an interrupted run left is the next step's to recover.
  [[ "$provider_backup" != true ]] || rm -f "$provider_previous"
}
trap cleanup_files EXIT
chmod 600 "$secret_tmp"
aws secretsmanager get-secret-value \
  --secret-id "$PROVIDER_SECRET_ARN" \
  --query SecretString --output text --region "$AWS_REGION" > "$secret_tmp"
python3 -c '
import json,re,sys
value=json.load(open(sys.argv[1]))
if not value.get("OPENAI_API_KEY") or not value.get("MESHY_API_KEY"):
    raise SystemExit("Provider credentials are not configured")
if sys.argv[2].strip().lower() == "true":
    key = str(value.get("STUDIO_GATEWAY_KEY") or "").strip()
    previous = str(value.get("STUDIO_GATEWAY_KEY_PREVIOUS") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9._~-]{16,}", key):
        raise SystemExit("PUBLIC_STUDIO requires a valid STUDIO_GATEWAY_KEY; the running release was preserved")
    if previous and (previous == key or not re.fullmatch(r"[A-Za-z0-9._~-]{16,}", previous)):
        raise SystemExit("STUDIO_GATEWAY_KEY_PREVIOUS must be another valid key; the running release was preserved")
' "$secret_tmp" "$PUBLIC_STUDIO"
# The character records database (the mogaesup server stack's CharacterDatabaseSecret on the shared PostgreSQL), once
# backend/infra/records-to-postgres.py has imported the records and named it in the config.
if [[ -n "${CHARACTER_DB_SECRET_ARN:-}" && -n "${CHARACTER_DB_HOST:-}" ]]; then
  aws secretsmanager get-secret-value --secret-id "$CHARACTER_DB_SECRET_ARN"     --query SecretString --output text --region "$AWS_REGION" | python3 -c '
import json, sys, urllib.parse
db = json.load(sys.stdin)
path, host = sys.argv[1], sys.argv[2]
value = json.load(open(path))
value["CHARACTER_DATABASE_URL"] = "postgresql://%s:%s@%s:5432/%s?sslmode=require" % (
    urllib.parse.quote(db["username"], safe=""), urllib.parse.quote(db["password"], safe=""), host, db["dbname"])
json.dump(value, open(path, "w"))' "$secret_tmp" "$CHARACTER_DB_HOST"
fi

image="gaesup-asset-studio:${release_sha}"
candidate="gaesup-asset-studio-candidate-${release_sha:0:12}"
if ! docker image inspect "$image" >/dev/null 2>&1; then
  docker build --pull -t "$image" -f "$source_root/infra/Dockerfile" "$source_root"
fi
if docker inspect -f '{{.State.Running}}' "$candidate" 2>/dev/null | grep -qx true || \
   docker ps --filter 'name=^gaesup-asset-studio-candidate-' --format '{{.Names}}' 2>/dev/null | grep -q .; then
  echo 'a previous candidate is still running; inspect and recover that deployment before submitting another' >&2
  exit 5
fi
docker rm "$candidate" >/dev/null 2>&1 || true

service_running() { docker inspect -f '{{.State.Running}}' "$service_name" 2>/dev/null | grep -qx true; }

# An earlier deployment that was killed before its commit (the SSM timeout skips its EXIT trap) left one of:
#  - the old runtime renamed for rollback and nothing under the stable name: it gets its name and its configuration back;
#  - the old runtime still under the stable name with the new configuration on disk: its configuration comes back, so a
#    restart of it does not start the old release with the new secrets.
# With both containers present the new runtime had already taken the stable name, so its configuration stays.
recover_interrupted() {
  local has_service=false has_rollback=false
  docker inspect "$service_name" >/dev/null 2>&1 && has_service=true
  docker inspect "$rollback_name" >/dev/null 2>&1 && has_rollback=true
  if [[ -f "$provider_previous" ]]; then
    if [[ "$has_service" != true || "$has_rollback" != true ]]; then
      mv -f "$provider_previous" /opt/asset-studio/provider.json
      echo 'restored the configuration an interrupted deployment had replaced' >&2
    else
      rm -f "$provider_previous"
    fi
  fi
  if [[ "$has_service" != true && "$has_rollback" == true ]]; then
    docker rename "$rollback_name" "$service_name"
    if ! service_running; then
      docker start "$service_name" >/dev/null
    fi
  fi
}
recover_interrupted

health_snapshot() {
  # Missing counters cannot prove that a release is idle. Readiness also waits for the configured database check.
  python3 -c '
import json, sys
try:
    health = json.load(sys.stdin)
    activity = health["activity"]
    counts = [activity[name] for name in ("paid_requests", "running_tasks")]
    if any(type(count) is not int or count < 0 for count in counts):
        raise ValueError("invalid activity counters")
    admission = health["admission"]
    if type(admission["version"]) is not int or admission["version"] != 1 or admission["verified"] is not True:
        raise ValueError("runtime admission cannot be verified")
    if sys.argv[1] in ("drain", "open"):
        if admission["draining"] is not (sys.argv[1] == "drain"):
            raise ValueError("runtime is still admitting work")
        print(sum(counts))
    else:
        database = health["connections"]["database"]
        if (health["status"] != "healthy" or type(database["configured"]) is not bool
                or (database["configured"] and database.get("ok") is not True)
                or admission["draining"] is not (sys.argv[1] == "candidate")):
            raise ValueError("candidate is not ready")
except (KeyError, TypeError, ValueError, AttributeError):
    sys.exit(1)
' "$1"
}

# A deployment that fails after closing admission can leave it closed with its token: a restored runtime that never
# answered, or no runtime at all. The token stays in $token_file, under the deploy lock, until admission is verified
# open, and the next deployment reuses it, so that drain is always its own to resume, never another operation's.
token_saved=false
token_created=false
if [[ -f "$token_file" ]]; then
  drain_token="$(tr -d '[:space:]' < "$token_file")"
  [[ "$drain_token" =~ ^[0-9a-f]{32}$ ]] || { echo "$token_file holds no admission token; inspect the runtime drain before deploying" >&2; exit 2; }
  token_saved=true
else
  drain_token="$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
fi
drain_payload="{\"token\":\"$drain_token\"}"
drain_acquired=false
save_token() {
  # Before anything can close admission with the token.
  [[ "$token_saved" == true ]] && return 0
  printf '%s\n' "$drain_token" > "$token_file.new"
  chmod 600 "$token_file.new"
  mv -f "$token_file.new" "$token_file"
  token_saved=true
  token_created=true
}
# One request to the runtime's loopback control. Sets admission_status (000: nothing answered) and admission_body.
admission_request() {
  local output
  # The token goes in on stdin, not on the command line other processes can read.
  output="$(curl --silent --max-time 5 -X "$1" -H 'Content-Type: application/json' --data @- \
    --write-out '\n%{http_code}' http://127.0.0.1:8000/internal/drain 2>/dev/null <<< "$drain_payload")" || true
  admission_status="${output##*$'\n'}"
  admission_body="${output%$'\n'*}"
  [[ "$admission_status" =~ ^[0-9]{3}$ ]] || admission_status=000
}
# A runtime that was just started or restored needs seconds before uvicorn listens: ask again, with the same token,
# until it answers or the wait ends. Repeating a drain or a reopen with one token changes nothing.
admission_call() {
  local deadline=$((SECONDS + ${ASSET_DEPLOY_REOPEN_SECONDS:-60}))
  while :; do
    admission_request "$1"
    [[ "$admission_status" == 000 || "$admission_status" == 5* ]] || return 0
    (( SECONDS < deadline )) && service_running || return 0
    sleep 2
  done
}
reopen_admission() {
  if ! service_running; then
    echo "no runtime is running to reopen admission; the next deployment resumes it with the token in $token_file" >&2
    return 1
  fi
  admission_call DELETE
  case "$admission_status" in
    200)
      if health_snapshot open <<< "$admission_body" >/dev/null; then
        drain_acquired=false
        rm -f "$token_file"
        return 0
      fi
      echo "runtime answered the reopen without verified open admission; the next deployment resumes it with the token in $token_file" >&2 ;;
    409) echo "runtime admission is held by another operation's token and stays closed until that operation resumes it" >&2 ;;
    000|5*) echo "runtime did not answer the admission reopen; it refuses new work until the next deployment resumes it with the token in $token_file" >&2 ;;
    *) echo "runtime refused the admission reopen (HTTP $admission_status); the next deployment resumes it with the token in $token_file" >&2 ;;
  esac
  return 1
}
release_admission() {
  if [[ "$drain_acquired" == true ]]; then
    reopen_admission || true
  fi
}
# Set once the running release is stopped for the candidate, until the candidate is committed: however this script ends
# in between (a failed command, an explicit exit, INT or TERM), the EXIT trap puts the previous runtime back first.
replacing=false
cleanup() {
  if [[ "$replacing" == true && "$provider_committed" != true ]]; then
    restore_previous || true
  fi
  cleanup_files
  release_admission
}
trap cleanup EXIT
trap 'exit 1' INT TERM

# Record database migrations, before anything is stopped: they only add (.github/scripts/check_migrations.py), so the
# running release works on the migrated schema, and one that fails leaves everything as it is. The new release's image
# applies them with the configuration it will run with; its output stays on the instance, as it may name the database.
if python3 -c 'import json, sys; sys.exit(0 if json.load(open(sys.argv[1])).get("CHARACTER_DATABASE_URL") else 1)' "$secret_tmp"; then
  if (( $(budget_left) < replace_seconds + 120 )); then
    echo "only $(budget_left) s of the deployment time limit are left, too few to migrate, drain, replace and roll back; nothing was changed. The image is built: deploy again" >&2
    exit 7
  fi
  migration_log=/var/log/asset-studio-migrate.log
  migration="gaesup-asset-studio-migrate-${release_sha:0:12}"
  docker rm -f "$migration" >/dev/null 2>&1 || true
  if timeout --kill-after=10 300 docker run --rm --name "$migration" --network host \
       -e ASSET_S3_BUCKET="$ASSET_S3_BUCKET" -e ASSET_S3_REGION="$AWS_REGION" -e AWS_REGION="$AWS_REGION" \
       -v "$secret_tmp:/run/studio-secrets.json:ro" \
       "$image" python -c 'import json, os, runpy, sys
os.environ["CHARACTER_DATABASE_URL"] = json.load(open("/run/studio-secrets.json"))["CHARACTER_DATABASE_URL"]
sys.argv = ["src.records", "migrate"]
runpy.run_module("src.records", run_name="__main__")' > "$migration_log" 2>&1; then
    grep -E '^(applied |record schema ready)' "$migration_log" || true
  else
    docker rm -f "$migration" >/dev/null 2>&1 || true
    echo "record database migration failed; nothing was changed and the running release keeps serving. The log is in $migration_log on the instance" >&2
    exit 8
  fi
fi

if (( $(budget_left) < replace_seconds + 30 )); then
  echo "only $(budget_left) s of the deployment time limit are left, too few to drain, replace and roll back; nothing was stopped. The image is built: deploy again" >&2
  exit 7
fi

# Close admission atomically before observing work. Old releases without the control endpoint remain running:
# there is no override that cuts off work whose admission cannot be closed and verified.
if service_running; then
  save_token
  drain_acquired=true
  admission_call POST
  case "$admission_status" in
    200)
      if ! health_snapshot drain <<< "$admission_body" >/dev/null; then
        echo 'running release answered the drain without verifiable closed admission; it was left running and admission will reopen' >&2
        exit 5
      fi ;;
    409)
      drain_acquired=false
      [[ "$token_created" == true ]] && rm -f "$token_file"
      echo 'runtime admission is already closed by another operation (idle stop, maintenance, or a drain whose token was lost); the running release was left as it is. Resume that drain with its own token, then deploy again' >&2
      exit 6 ;;
    000|5*)
      echo 'running release did not answer the admission drain; it was left running and admission will reopen' >&2
      exit 5 ;;
    *)
      drain_acquired=false
      [[ "$token_created" == true ]] && rm -f "$token_file"
      echo 'running release does not support verified admission drain; it was left running. Install the drain-capable runtime during an operator maintenance window before using automatic deployment' >&2
      exit 5 ;;
  esac
fi

# Existing admitted work retains its grant until its background and provider stages have finished.
drain_deadline=$((SECONDS + ${ASSET_DEPLOY_DRAIN_SECONDS:-420}))
# The replacement and a rollback must still fit in the deployment time limit after the wait.
(( drain_deadline <= SECONDS + $(budget_left) - replace_seconds )) || drain_deadline=$((SECONDS + $(budget_left) - replace_seconds))
while docker inspect -f '{{.State.Running}}' "$service_name" 2>/dev/null | grep -qx true; do
  busy="$(curl --fail --silent --max-time 5 http://127.0.0.1:8080/api/health | health_snapshot drain || echo unknown)"
  if [[ "$busy" == unknown ]]; then
    echo 'running release health cannot be read, so paid or background work cannot be ruled out; deployment stopped and admission will reopen' >&2
    exit 5
  fi
  [[ "$busy" == 0 ]] && break
  if (( SECONDS >= drain_deadline )); then
    echo "running release still has $busy paid or background tasks; deploy again once it is idle" >&2
    exit 4
  fi
  sleep 5
done

original_id="$(docker inspect -f '{{.Id}}' "$service_name" 2>/dev/null || true)"
candidate_id=''
restored=false
restore_previous() {
  trap - ERR INT TERM
  [[ "$restored" != true ]] || return 0
  restored=true
  restore_provider
  if [[ -z "$candidate_id" ]]; then
    candidate_id="$(docker inspect -f '{{.Id}}' "$candidate" 2>/dev/null || true)"
  fi
  current_id="$(docker inspect -f '{{.Id}}' "$service_name" 2>/dev/null || true)"
  if [[ -n "$candidate_id" ]] && docker inspect "$candidate_id" >/dev/null 2>&1; then
    if [[ "$candidate_id" != "$original_id" ]]; then
      docker rm -f "$candidate_id" >/dev/null 2>&1 || true
    fi
  fi
  current_id="$(docker inspect -f '{{.Id}}' "$service_name" 2>/dev/null || true)"
  if [[ -n "$original_id" ]] && docker inspect "$original_id" >/dev/null 2>&1; then
    if [[ -n "$current_id" && "$current_id" != "$original_id" ]]; then
      docker rm -f "$current_id" >/dev/null 2>&1 || true
      current_id=''
    fi
    if [[ "$current_id" != "$original_id" ]]; then
      docker rename "$original_id" "$service_name" >/dev/null
    fi
    if ! docker inspect -f '{{.State.Running}}' "$original_id" 2>/dev/null | grep -qx true; then
      docker start "$original_id" >/dev/null
    fi
  elif [[ -n "$current_id" && "$current_id" == "$candidate_id" ]]; then
    docker rm -f "$current_id" >/dev/null 2>&1 || true
  fi
  # The EXIT trap reopens admission once the restored runtime answers.
}
replacing=true
trap 'exit 1' ERR INT TERM

# Keep the previous configuration with its container; a failed candidate must not change rollback credentials.
if [[ -f /opt/asset-studio/provider.json ]]; then
  cp -p /opt/asset-studio/provider.json "$provider_previous.new"
  mv -f "$provider_previous.new" "$provider_previous"
  provider_backup=true
fi
mv -f "$secret_tmp" /opt/asset-studio/provider.json
secret_tmp=''
provider_installed=true

if docker inspect "$service_name" >/dev/null 2>&1; then
  if docker inspect -f '{{.State.Running}}' "$rollback_name" 2>/dev/null | grep -qx true; then
    echo 'a previous rollback container is still running; recover it before replacing this release' >&2
    exit 5
  fi
  docker rm "$rollback_name" >/dev/null 2>&1 || true
  docker rename "$service_name" "$rollback_name"
  docker stop -t 30 "$rollback_name" >/dev/null
fi

# The candidate starts with admission closed by this deployment's token, also when no runtime was running before: a
# failure from here on leaves the drain to this run's EXIT trap or, when nothing answers, to the next deployment.
# Docker does not restart it (a reboot, a daemon restart) before it is verified, so an unverified release never comes
# back by itself.
save_token
drain_acquired=true
start_id="$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
# The token reaches the candidate as a file in a folder of its own (neither `ps` nor `docker inspect` shows it). The
# file goes once the candidate has applied it; the folder stays while a container that mounts it exists.
# Host networking stays: the instance's metadata service answers one network hop only (ec2.yaml HttpPutResponseHopLimit
# 1), so a bridged container would get no role credentials for S3 and the secrets, and nginx serves CloudFront on port
# 80. The container runs as root for nginx's port 80 and the rules entrypoint.py writes under /etc/nginx.
start_dir="/opt/asset-studio/start-tokens/$start_id"
install -d -m 700 /opt/asset-studio/start-tokens "$start_dir"
(umask 077; printf '%s\n' "$drain_token" > "$start_dir/token")
docker run -d --restart no --name "$candidate" --network host \
  --log-driver json-file --log-opt max-size=50m --log-opt max-file=3 \
  --label gaesup.release.sha256="$release_sha" \
  --label gaesup.start.id="$start_id" \
  -e ASSET_S3_BUCKET="$ASSET_S3_BUCKET" \
  -e ASSET_S3_REGION="$AWS_REGION" \
  -e AWS_REGION="$AWS_REGION" \
  -e STUDIO_RELEASE_SHA="$release_sha" \
  -e ASSET_START_DRAIN_TOKEN_FILE=/run/start-token/token \
  --mount "type=bind,source=$start_dir,target=/run/start-token,readonly" \
  -e ASSET_START_DRAIN_ID="$start_id" \
  -e PUBLIC_STUDIO="$PUBLIC_STUDIO" \
  -v /opt/asset-studio/provider.json:/run/studio-secrets.json:ro \
  -v /opt/asset-studio/scratch:/app/data \
  -v /var/log/asset-studio:/var/log/nginx \
  "$image" >/dev/null
candidate_id="$(docker inspect -f '{{.Id}}' "$candidate")"

healthy=false
for _ in $(seq 1 30); do
  # Stop waiting while a rollback still fits in the deployment time limit.
  (( $(budget_left) > rollback_seconds )) || break
  if docker inspect -f '{{.State.Running}}' "$candidate" 2>/dev/null | grep -qx true && \
     curl --fail --silent --show-error --max-time 3 http://127.0.0.1:8080/api/health | health_snapshot candidate && \
     curl --fail --silent --show-error --max-time 3 http://127.0.0.1:8080/version.json | grep -Eq '"release_sha"[[:space:]]*:[[:space:]]*"'"$release_sha"'"'; then
    healthy=true
    break
  fi
  sleep 2
done
if [[ "$healthy" != true ]]; then
  # Kept on the instance: this script's output is printed in the pipeline's public log.
  docker logs --tail 100 "$candidate" > /var/log/asset-studio-failed-candidate.log 2>&1 || true
  echo 'the failed candidate container log is in /var/log/asset-studio-failed-candidate.log' >&2
  restore_previous
  echo 'candidate health check failed; previous container restored' >&2
  exit 1
fi
# Applied: the candidate answered with admission closed by it.
rm -f "$start_dir/token"
# Port 80 (CloudFront's way in) must not let a request without the gateway key through: 403 with PUBLIC_STUDIO, 404
# without it. With PUBLIC_STUDIO, the key (in a header file, not on the command line) must get through.
public_status="$(curl --silent --max-time 3 --output /dev/null --write-out '%{http_code}' http://127.0.0.1/api/health 2>/dev/null || true)"
public_status="${public_status##*$'\n'}"
if [[ "$public_status" =~ ^[23][0-9][0-9]$ ]]; then
  restore_previous
  echo "port 80 answered HTTP $public_status to a request without the gateway key; previous container restored" >&2
  exit 1
fi
if [[ "${PUBLIC_STUDIO,,}" == true ]]; then
  gateway_header="$(mktemp /opt/asset-studio/gateway-header.XXXXXX)"
  python3 -c 'import json, sys; print("x-gateway-key: " + str(json.load(open(sys.argv[1]))["STUDIO_GATEWAY_KEY"]).strip())' \
    /opt/asset-studio/provider.json > "$gateway_header"
  keyed_status="$(curl --silent --max-time 5 --output /dev/null --write-out '%{http_code}' -H "@$gateway_header" http://127.0.0.1/api/health 2>/dev/null || true)"
  rm -f "$gateway_header"
  gateway_header=''
  keyed_status="${keyed_status##*$'\n'}"
  if [[ "$keyed_status" != 200 ]]; then
    restore_previous
    echo "port 80 answered HTTP $keyed_status to a request with the gateway key; previous container restored" >&2
    exit 1
  fi
fi
release_dir="/opt/asset-studio/releases/$release_sha"
if [[ -e "$release_dir" ]] && ! grep -qx "$release_sha" "$release_dir/.release-sha256"; then
  restore_previous
  echo 'existing release directory has a mismatched hash marker; previous container restored' >&2
  exit 1
fi
docker update --restart unless-stopped "$candidate" >/dev/null

docker rename "$candidate" "$service_name"

if [[ -e "$release_dir" ]]; then
  rm -rf "$source_root"
else
  mv "$source_root" "$release_dir"
fi
printf '{"release_key":"%s","sha256":"%s","deployed_at":"%s"}\n' \
  "$release_key" "$release_sha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /opt/asset-studio/current.json.new
mv -f /opt/asset-studio/current.json.new /opt/asset-studio/current.json
provider_committed=true
rm -f "$provider_previous"
provider_backup=false
replacing=false
trap - ERR INT TERM
# The release a stack update passes as ReleaseKey (backend/infra/ec2.yaml); needs the role's ssm:PutParameter.
aws ssm put-parameter --name /asset-studio/current-release --type String --overwrite --value "$release_key" \
  --region "$AWS_REGION" >/dev/null 2>&1 \
  || echo 'the release could not be recorded in the SSM parameter /asset-studio/current-release; current.json has it' >&2
# No unverified mutation can run in a candidate before commit. After opening, a lost control response must
# never force-stop this runtime: a newly accepted paid request may already exist.
if ! reopen_admission; then
  echo 'candidate is committed and healthy, but admission reopen could not be verified; runtime was preserved. Inspect the saved local drain' >&2
  exit 5
fi
docker rm "$rollback_name" >/dev/null 2>&1 || true
# Power off after two idle hours; the app starts the instance again on demand. Kept up to date with each release.
bash "$release_dir/infra/idle-stop.sh" install || echo 'idle stop could not be installed' >&2

# Each release is an image of about 0.4 GB and a source folder: keep the newest few, the running one always among them.
prune_releases() {
  local keep=${ASSET_KEEP_RELEASES:-3} tag name
  touch "$release_dir"
  docker image ls --format '{{.CreatedAt}}|{{.Repository}}:{{.Tag}}' gaesup-asset-studio | sort -r | cut -d'|' -f2 \
    | tail -n +$((keep + 1)) | while read -r tag; do
      [[ "$tag" == "$image" ]] || docker image rm "$tag" >/dev/null 2>&1 || true
    done
  docker image prune -f >/dev/null 2>&1 || true
  ls -1t /opt/asset-studio/releases | tail -n +$((keep + 1)) | while read -r name; do
    if [[ "$name" =~ ^[0-9a-f]{64}$ && "$name" != "$release_sha" ]]; then
      rm -rf "/opt/asset-studio/releases/$name"
    fi
  done
  # Startup token folders of containers that are gone; a container that still exists may restart and mounts its own.
  local used
  used="$(docker inspect -f '{{index .Config.Labels "gaesup.start.id"}}' "$service_name" "$rollback_name" 2>/dev/null || true)"
  for name in /opt/asset-studio/start-tokens/*; do
    if [[ -d "$name" ]] && ! grep -qxF "$(basename "$name")" <<< "$used"; then
      rm -rf "$name"
    fi
  done
  # Sources that earlier, failed deployments left behind.
  for name in /opt/asset-studio/incoming/*; do
    if [[ -d "$name" && "$(basename "$name")" =~ ^[0-9a-f]{64}$ && "$(basename "$name")" != "$release_sha" ]]; then
      rm -rf "$name"
    fi
  done
}
prune_releases || echo 'earlier releases could not be pruned' >&2
echo "deployment healthy: $release_sha"
