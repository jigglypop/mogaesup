#!/usr/bin/env bash
# Powers the studio instance off once nobody has used it for a while; the Rust server starts it again on demand
# (server/src/studio_power.rs). An EBS-backed instance stops on poweroff and keeps its Elastic IP.
#
#   idle-stop.sh           one check (asset-studio-idle.timer runs it every 5 minutes; decisions go to the journal:
#                          journalctl -u asset-studio-idle)
#   idle-stop.sh install   installs this script and its timer (deploy-on-instance.sh does this on every deploy)
#
# It never stops the instance within IDLE_BOOT_GRACE_MINUTES of boot, while a deployment runs, while the API reports
# paid requests or running tasks, or while that cannot be read. Idle time counts from the latest of: the last request
# nginx logged (health and release probes excluded, see nginx.conf), the last check that found work, the container's
# start and the boot. Settings: /etc/asset-studio-idle.env (IDLE_STOP_MINUTES=120, IDLE_BOOT_GRACE_MINUTES=30,
# IDLE_STOP=off to keep the instance on).
set -Eeuo pipefail

service_name=gaesup-asset-studio
log_dir=/var/log/asset-studio
activity_log="$log_dir/activity.log"
state_dir=/var/lib/asset-studio-idle
installed=/usr/local/sbin/asset-studio-idle-stop

install_units() {
  install -d -m 755 "$log_dir"
  install -d -m 700 "$state_dir"
  install -m 755 "$0" "$installed.new"
  sed -i 's/\r$//' "$installed.new"
  mv -f "$installed.new" "$installed"
  cat > /etc/systemd/system/asset-studio-idle.service <<UNIT
[Unit]
Description=Power the asset studio off when it has been idle
After=docker.service

[Service]
Type=oneshot
Environment=IDLE_STOP_MINUTES=120 IDLE_BOOT_GRACE_MINUTES=30
EnvironmentFile=-/etc/asset-studio-idle.env
ExecStart=$installed
SyslogIdentifier=asset-studio-idle
UNIT
  cat > /etc/systemd/system/asset-studio-idle.timer <<'UNIT'
[Unit]
Description=Check every 5 minutes whether the asset studio is idle

[Timer]
OnBootSec=10min
OnUnitActiveSec=5min
AccuracySec=30s

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now asset-studio-idle.timer >/dev/null
  echo "idle stop installed: $(systemctl is-active asset-studio-idle.timer) timer, $installed"
}

if [[ "${1:-}" == install ]]; then
  install_units
  exit 0
fi

keep() { echo "keeping on: $*"; exit 0; }

# Only the last request matters; keep the file small without changing its time. Also with IDLE_STOP=off, where nothing
# else would ever shorten it.
trim_activity_log() {
  [[ -f "$activity_log" ]] || return 0
  (( $(stat -c %s "$activity_log") > 8 * 1024 * 1024 )) || return 0
  install -d -m 700 "$state_dir"
  local mtime
  mtime=$(stat -c %Y "$activity_log")
  tail -n 1000 "$activity_log" > "$state_dir/activity.tail" && cat "$state_dir/activity.tail" > "$activity_log"
  rm -f "$state_dir/activity.tail"
  touch -d "@$mtime" "$activity_log"
}
trim_activity_log

[[ "${IDLE_STOP:-on}" == off ]] && keep 'IDLE_STOP=off'
idle_limit=$(( ${IDLE_STOP_MINUTES:-120} * 60 ))
boot_grace=$(( ${IDLE_BOOT_GRACE_MINUTES:-30} * 60 ))
(( idle_limit >= 1800 )) || keep "IDLE_STOP_MINUTES below 30 is not accepted"

now=$(date +%s)
uptime_seconds=$(cut -d. -f1 /proc/uptime)
if (( uptime_seconds < boot_grace )); then
  keep "booted $(( uptime_seconds / 60 )) min ago"
fi
boot=$(( now - uptime_seconds ))

# A deployment replaces the container; its locks are held while it runs.
for lock in /var/lock/asset-studio-deploy.lock /var/lock/asset-studio-prepare.lock; do
  exec {lock_fd}>"$lock"
  if ! flock -n "$lock_fd"; then
    keep "a deployment is running"
  fi
done

read_activity() {
  python3 -c '
import json, sys
try:
    value = json.load(sys.stdin)
    activity, admission = value["activity"], value["admission"]
    counts = [activity[name] for name in ("paid_requests", "running_tasks")]
    if (any(type(count) is not int or count < 0 for count in counts)
            or type(admission["version"]) is not int or admission["version"] != 1
            or admission["verified"] is not True or type(admission["draining"]) is not bool
            or (sys.argv[1] == "drained" and admission["draining"] is not True)):
        raise ValueError("unverified work")
    print(*counts)
except (KeyError, TypeError, ValueError, AttributeError):
    sys.exit(1)
' "${1:-observe}"
}

install -d -m 700 "$state_dir"
last=$boot
latest() { (( $1 > last )) && last=$1; return 0; }

running=$(docker inspect -f '{{.State.Running}}' "$service_name" 2>/dev/null || echo missing)
if [[ "$running" == true ]]; then
  started=$(date -d "$(docker inspect -f '{{.State.StartedAt}}' "$service_name")" +%s 2>/dev/null || echo 0)
  latest "$started"
  busy=$(curl --silent --fail --max-time 10 http://127.0.0.1:8080/api/health | read_activity) || keep "the API health (paid requests, running tasks) could not be read"
  read -r paid tasks <<< "$busy"
  if (( paid + tasks > 0 )); then
    touch "$state_dir/last-busy"
    keep "$paid paid requests and $tasks tasks running"
  fi
else
  keep 'runtime admission cannot be closed while the API is unavailable'
fi
[[ -f "$state_dir/last-busy" ]] && latest "$(stat -c %Y "$state_dir/last-busy")"

if [[ -f "$activity_log" ]]; then
  latest "$(stat -c %Y "$activity_log")"
elif [[ "$running" == true ]]; then
  # A release from before the activity log: read the container's own access log, leaving out probes.
  line=$(docker exec "$service_name" sh -c 'tail -n 5000 /var/log/nginx/access.log 2>/dev/null' \
    | grep -Ev '"(GET|HEAD) /(api/health|health|version\.json)[ ?]' | tail -n 1 || true)
  stamp=$(sed -nE 's/^[^[]*\[([0-9]{2})\/([A-Za-z]{3})\/([0-9]{4}):([0-9:]{8}) ([-+][0-9]{4})\].*/\1 \2 \3 \4 \5/p' <<< "$line")
  if [[ -n "$stamp" ]]; then
    latest "$(date -d "$stamp" +%s)"
  fi
fi

idle=$(( now - last ))
if (( idle < idle_limit )); then
  keep "idle $(( idle / 60 )) of $(( idle_limit / 60 )) min"
fi
# Close admission before the final observation; a request accepted before drain is visible here.
# The deploy/prepare locks stay held through the poweroff request.
drain_token="$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
drain_payload="{\"token\":\"$drain_token\"}"
drain_acquired=true
control_admission() {
  curl --silent --show-error --fail --max-time 5 -X "$1" -H 'Content-Type: application/json' \
    --data "$drain_payload" http://127.0.0.1:8000/internal/drain
}
release_admission() {
  if [[ "$drain_acquired" == true ]]; then
    control_admission DELETE >/dev/null || echo 'could not reopen runtime admission; local operator resume is required' >&2
  fi
}
trap release_admission EXIT
trap 'exit 1' INT TERM
busy=$(control_admission POST | read_activity drained) || keep 'runtime admission drain could not be verified'
read -r paid tasks <<< "$busy"
if (( paid + tasks > 0 )); then
  touch "$state_dir/last-busy"
  keep "$paid paid requests and $tasks tasks admitted before drain"
fi
# A request could have completed between the first idle check and admission closing.
[[ -f "$activity_log" ]] && latest "$(stat -c %Y "$activity_log")"
idle=$(( $(date +%s) - last ))
(( idle >= idle_limit )) || keep 'a request arrived before runtime admission closed'
echo "powering off: idle $(( idle / 60 )) min with no paid requests or tasks"
if systemctl poweroff; then
  # Keep admission closed until the next API start proves it owns the server lease.
  drain_acquired=false
else
  exit 1
fi
