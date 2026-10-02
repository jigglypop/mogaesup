#!/usr/bin/env bash
set -Eeuo pipefail

release_key="${1:?release key is required}"
release_sha="${2:?release sha256 is required}"
source_root="${3:?extracted release directory is required}"
config_file=/etc/asset-studio.env
service_name=gaesup-asset-studio
rollback_name=gaesup-asset-studio-rollback
expected_source="/opt/asset-studio/incoming/$release_sha/source"

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
PUBLIC_SITE_ORIGIN="${PUBLIC_SITE_ORIGIN:-}"
PUBLIC_STUDIO="${PUBLIC_STUDIO:-false}"

exec 9>/var/lock/asset-studio-deploy.lock
flock -n 9 || { echo 'another deployment is active' >&2; exit 3; }

install -d -m 700 /opt/asset-studio /opt/asset-studio/releases /opt/asset-studio/scratch
# nginx's logs, on the host so infra/idle-stop.sh sees the last request even while no container runs.
install -d -m 755 /var/log/asset-studio
secret_tmp="$(mktemp /opt/asset-studio/provider.json.XXXXXX)"
provider_backup=''
provider_installed=false
provider_committed=false
restore_provider() {
  if [[ "$provider_installed" == true && "$provider_committed" != true ]]; then
    if [[ -n "$provider_backup" ]]; then
      mv -f "$provider_backup" /opt/asset-studio/provider.json
      provider_backup=''
    else
      rm -f /opt/asset-studio/provider.json
    fi
    provider_installed=false
  fi
}
cleanup_files() {
  restore_provider
  [[ -z "$secret_tmp" ]] || rm -f "$secret_tmp"
  [[ -z "$provider_backup" ]] || rm -f "$provider_backup"
}
trap cleanup_files EXIT
chmod 600 "$secret_tmp"
aws secretsmanager get-secret-value \
  --secret-id "$PROVIDER_SECRET_ARN" \
  --query SecretString --output text --region "$AWS_REGION" > "$secret_tmp"
python3 -c 'import json,sys; value=json.load(open(sys.argv[1])); assert value.get("OPENAI_API_KEY") and value.get("MESHY_API_KEY")' "$secret_tmp"
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
if docker inspect -f '{{.State.Running}}' "$candidate" 2>/dev/null | grep -qx true; then
  echo 'a previous candidate is still running; inspect and recover that deployment before submitting another' >&2
  exit 5
fi
docker rm "$candidate" >/dev/null 2>&1 || true

# Recover the stable name first if an earlier process ended between rename and rollback.
if ! docker inspect "$service_name" >/dev/null 2>&1 && docker inspect "$rollback_name" >/dev/null 2>&1; then
  docker rename "$rollback_name" "$service_name"
  if ! docker inspect -f '{{.State.Running}}' "$service_name" 2>/dev/null | grep -qx true; then
    docker start "$service_name" >/dev/null
  fi
fi

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

drain_token="$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
drain_payload="{\"token\":\"$drain_token\"}"
drain_acquired=false
control_admission() {
  curl --fail --silent --show-error --max-time 5 -X "$1" -H 'Content-Type: application/json' \
    --data "$drain_payload" http://127.0.0.1:8000/internal/drain
}
release_admission() {
  if [[ "$drain_acquired" == true ]]; then
    control_admission DELETE >/dev/null || echo 'could not reopen runtime admission; resume the saved local drain before accepting work' >&2
  fi
}
cleanup() { cleanup_files; release_admission; }
trap cleanup EXIT
trap 'exit 1' INT TERM

# Close admission atomically before observing work. Old releases without the control endpoint remain running:
# there is no override that cuts off work whose admission cannot be closed and verified.
if docker inspect -f '{{.State.Running}}' "$service_name" 2>/dev/null | grep -qx true; then
  drain_acquired=true
  if ! control_admission POST | health_snapshot drain >/dev/null; then
    echo 'running release does not support verified admission drain; it was left running. Install the drain-capable runtime during an operator maintenance window before using automatic deployment' >&2
    exit 5
  fi
fi

# Existing admitted work retains its grant until its background and provider stages have finished.
drain_deadline=$((SECONDS + ${ASSET_DEPLOY_DRAIN_SECONDS:-420}))
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
restore_previous() {
  trap - ERR INT TERM
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
}
trap 'restore_previous; exit 1' ERR INT TERM

# Keep the previous configuration with its container; a failed candidate must not change rollback credentials.
if [[ -f /opt/asset-studio/provider.json ]]; then
  provider_backup="$(mktemp /opt/asset-studio/provider.previous.XXXXXX)"
  cp -p /opt/asset-studio/provider.json "$provider_backup"
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

docker run -d --restart unless-stopped --name "$candidate" --network host \
  --log-driver json-file --log-opt max-size=50m --log-opt max-file=3 \
  --label gaesup.release.sha256="$release_sha" \
  -e ASSET_S3_BUCKET="$ASSET_S3_BUCKET" \
  -e ASSET_S3_REGION="$AWS_REGION" \
  -e AWS_REGION="$AWS_REGION" \
  -e STUDIO_RELEASE_SHA="$release_sha" \
  -e ASSET_START_DRAIN_TOKEN="$drain_token" \
  -e PUBLIC_SITE_ORIGIN="$PUBLIC_SITE_ORIGIN" \
  -e PUBLIC_STUDIO="$PUBLIC_STUDIO" \
  -v /opt/asset-studio/provider.json:/run/studio-secrets.json:ro \
  -v /opt/asset-studio/scratch:/app/data \
  -v /var/log/asset-studio:/var/log/nginx \
  "$image" >/dev/null
candidate_id="$(docker inspect -f '{{.Id}}' "$candidate")"

healthy=false
for _ in $(seq 1 30); do
  if docker inspect -f '{{.State.Running}}' "$candidate" 2>/dev/null | grep -qx true && \
     curl --fail --silent --show-error --max-time 3 http://127.0.0.1:8080/api/health | health_snapshot candidate && \
     curl --fail --silent --show-error --max-time 3 http://127.0.0.1:8080/version.json | grep -Eq '"release_sha"[[:space:]]*:[[:space:]]*"'"$release_sha"'"'; then
    healthy=true
    break
  fi
  sleep 2
done
if [[ "$healthy" != true ]]; then
  docker logs --tail 100 "$candidate" >&2 || true
  restore_previous
  echo 'candidate health check failed; previous container restored' >&2
  exit 1
fi

docker rename "$candidate" "$service_name"

release_dir="/opt/asset-studio/releases/$release_sha"
if [[ -e "$release_dir" ]]; then
  grep -qx "$release_sha" "$release_dir/.release-sha256" || { echo 'existing release directory has a mismatched hash marker' >&2; exit 1; }
  rm -rf "$source_root"
else
  mv "$source_root" "$release_dir"
fi
printf '{"release_key":"%s","sha256":"%s","deployed_at":"%s"}\n' \
  "$release_key" "$release_sha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /opt/asset-studio/current.json.new
mv -f /opt/asset-studio/current.json.new /opt/asset-studio/current.json
provider_committed=true
trap - ERR INT TERM
# No unverified mutation can run in a candidate before commit. After opening, a lost control response must
# never force-stop this runtime: a newly accepted paid request may already exist.
if ! control_admission DELETE | health_snapshot open >/dev/null; then
  echo 'candidate is committed and healthy, but admission reopen could not be verified; runtime was preserved. Inspect the saved local drain' >&2
  exit 5
fi
drain_acquired=false
docker rm "$rollback_name" >/dev/null 2>&1 || true
# Power off after two idle hours; the app starts the instance again on demand. Kept up to date with each release.
bash "$release_dir/infra/idle-stop.sh" install || echo 'idle stop could not be installed' >&2
echo "deployment healthy: $release_sha"
