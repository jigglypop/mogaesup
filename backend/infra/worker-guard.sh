#!/usr/bin/env bash
# Keeps the studio's Blender workers away from the instance metadata service, and with it from the instance role's
# credentials, and from the API's own loopback ports. The workers parse provider-made and uploaded files as
# studio-worker (uid 10001: infra/Dockerfile, infra/blender-worker.py). The container shares the host's network
# (deploy-on-instance.sh), so the host's firewall sees that uid on their sockets and refuses its connections to the
# metadata addresses and to 127.0.0.1:8000 (uvicorn) and :8080 (nginx, which names the operator); the API, root in the
# container, still reaches the metadata service for its S3 and secret access. A Blender that serves a port (the editor
# CLI's) still answers on it: only connections the worker opens are refused.
#
#   worker-guard.sh           applies the rules (asset-studio-worker-guard.service does at every boot, before Docker)
#   worker-guard.sh install   installs this script and that unit, then applies the rules (deploy-on-instance.sh does on
#                             every deploy)
set -Eeuo pipefail

worker_uid=10001
installed=/usr/local/sbin/asset-studio-worker-guard

# Adds the rule (the words after the tool) for the worker's packets, unless the chain has it already.
refuse() {
  local tool="$1"
  shift
  "$tool" -w -C OUTPUT "$@" -m owner --uid-owner "$worker_uid" -j REJECT 2>/dev/null \
    || "$tool" -w -I OUTPUT 1 "$@" -m owner --uid-owner "$worker_uid" -j REJECT
}

apply() {
  if ! command -v iptables >/dev/null 2>&1; then
    echo "iptables is not installed: uid $worker_uid can reach the instance metadata service" >&2
    return 1
  fi
  refuse iptables -d 169.254.169.254/32
  refuse iptables -d 127.0.0.0/8 -p tcp --dport 8000
  refuse iptables -d 127.0.0.0/8 -p tcp --dport 8080
  # The IPv6 address answers only on instances that enable it; closed as well where the host has IPv6 rules.
  if command -v ip6tables >/dev/null 2>&1; then
    { refuse ip6tables -d fd00:ec2::254/128 && refuse ip6tables -d ::1/128 -p tcp --dport 8000 \
        && refuse ip6tables -d ::1/128 -p tcp --dport 8080; } \
      || echo "the IPv6 addresses could not be closed to uid $worker_uid" >&2
  fi
  echo "instance metadata service and API ports closed to uid $worker_uid"
}

install_unit() {
  install -m 755 "$0" "$installed.new"
  sed -i 's/\r$//' "$installed.new"
  mv -f "$installed.new" "$installed"
  cat > /etc/systemd/system/asset-studio-worker-guard.service <<UNIT
[Unit]
Description=Keep the asset studio's Blender workers away from the instance metadata service
Before=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$installed
SyslogIdentifier=asset-studio-worker-guard

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable asset-studio-worker-guard.service >/dev/null
}

if [[ "${1:-}" == install ]]; then
  install_unit
fi
apply
