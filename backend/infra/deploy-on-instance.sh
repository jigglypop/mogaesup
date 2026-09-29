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
secret_tmp="$(mktemp /opt/asset-studio/provider.json.XXXXXX)"
chmod 600 "$secret_tmp"
aws secretsmanager get-secret-value \
  --secret-id "$PROVIDER_SECRET_ARN" \
  --query SecretString --output text --region "$AWS_REGION" > "$secret_tmp"
python3 -c 'import json,sys; value=json.load(open(sys.argv[1])); assert value.get("OPENAI_API_KEY") and value.get("MESHY_API_KEY")' "$secret_tmp"
mv -f "$secret_tmp" /opt/asset-studio/provider.json

image="gaesup-asset-studio:${release_sha}"
candidate="gaesup-asset-studio-candidate-${release_sha:0:12}"
if ! docker image inspect "$image" >/dev/null 2>&1; then
  docker build --pull -t "$image" -f "$source_root/infra/Dockerfile" "$source_root"
fi
docker rm -f "$candidate" >/dev/null 2>&1 || true

# Recover the stable name first if an earlier process ended between rename and rollback.
if ! docker inspect "$service_name" >/dev/null 2>&1 && docker inspect "$rollback_name" >/dev/null 2>&1; then
  docker rename "$rollback_name" "$service_name"
  if ! docker inspect -f '{{.State.Running}}' "$service_name" 2>/dev/null | grep -qx true; then
    docker start "$service_name" >/dev/null
  fi
fi

# Replace the running release only once it reports no paid requests and no background work,
# as start-local.ps1 does. A release that cannot be reached is replaced as before. The default
# drain leaves room for the image build and health check inside the 900 s SSM command timeout.
drain_deadline=$((SECONDS + ${ASSET_DEPLOY_DRAIN_SECONDS:-420}))
while docker inspect -f '{{.State.Running}}' "$service_name" 2>/dev/null | grep -qx true; do
  busy="$(curl --silent --max-time 5 http://127.0.0.1:8080/api/health | python3 -c '
import json, sys
activity = json.load(sys.stdin).get("activity") or {}
print(int(activity.get("paid_requests", 0)) + int(activity.get("running_tasks", 0)))' 2>/dev/null || echo unknown)"
  [[ "$busy" == 0 || "$busy" == unknown ]] && break
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

if docker inspect "$service_name" >/dev/null 2>&1; then
  docker rm -f "$rollback_name" >/dev/null 2>&1 || true
  docker rename "$service_name" "$rollback_name"
  docker stop -t 30 "$rollback_name" >/dev/null
fi

docker run -d --restart unless-stopped --name "$candidate" --network host \
  --label gaesup.release.sha256="$release_sha" \
  -e ASSET_S3_BUCKET="$ASSET_S3_BUCKET" \
  -e ASSET_S3_REGION="$AWS_REGION" \
  -e AWS_REGION="$AWS_REGION" \
  -e STUDIO_RELEASE_SHA="$release_sha" \
  -e PUBLIC_SITE_ORIGIN="$PUBLIC_SITE_ORIGIN" \
  -e PUBLIC_STUDIO="$PUBLIC_STUDIO" \
  -v /opt/asset-studio/provider.json:/run/studio-secrets.json:ro \
  -v /opt/asset-studio/scratch:/app/data \
  "$image" >/dev/null
candidate_id="$(docker inspect -f '{{.Id}}' "$candidate")"

healthy=false
for _ in $(seq 1 30); do
  if docker inspect -f '{{.State.Running}}' "$candidate" 2>/dev/null | grep -qx true && \
     curl --fail --silent --show-error --max-time 3 http://127.0.0.1:8080/api/health | grep -Eq '"status"[[:space:]]*:[[:space:]]*"(healthy|degraded)"' && \
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
  "$release_key" "$release_sha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /opt/asset-studio/current.json
docker rm -f "$rollback_name" >/dev/null 2>&1 || true
trap - ERR INT TERM
echo "deployment healthy: $release_sha"
