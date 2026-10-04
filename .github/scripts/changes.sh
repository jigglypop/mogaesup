#!/usr/bin/env bash
# Decides which checks run and which parts are deployed.
# Environment: EVENT (pull_request | push | workflow_dispatch), REF, TARGET (the dispatch input: all | server | web |
# studio), BASE (the commit the checks compare with: a pull request's base, or the last push run that passed in full;
# empty when there is none) and BASE_SERVER, BASE_WEB, BASE_STUDIO (the commit each part was last deployed from, found by
# deploy_bases.py; empty when unknown). Writes name=true|false lines to $GITHUB_OUTPUT.
set -euo pipefail

out="${GITHUB_OUTPUT:-/dev/stdout}"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
event="${EVENT:?EVENT is required}"
ref="${REF:-refs/heads/main}"
base="${BASE:-}"
target="${TARGET:-}"
declare -A part_base=([server]="${BASE_SERVER:-}" [web]="${BASE_WEB:-}" [studio]="${BASE_STUDIO:-}")

known() { [ -n "$1" ] && git cat-file -e "$1^{commit}" 2>/dev/null; }

# Paths as they are, Hangul included (the default quoting would hide them from every pattern below).
changed_since() { git -c core.quotePath=false diff --no-renames --name-only "$1" HEAD; }

# Everything is checked when there is nothing to compare with and on a manual run.
all=false
files=
if [ "$event" = workflow_dispatch ] || ! known "$base"; then
  all=true
else
  files=$(changed_since "$base")
fi

check() {
  [ "$all" = true ] || grep -Eq "$1" <<<"$files"
}

# shellcheck source=release_parts.sh
source "$(dirname "${BASH_SOURCE[0]}")/release_parts.sh"

# Only main deploys: its pushes, and manual runs, which deploy their target and whatever is still pending.
deploy_ok=false
if [ "$ref" = refs/heads/main ] && { [ "$event" = push ] || [ "$event" = workflow_dispatch ]; }; then deploy_ok=true; fi

# A part is deployed when it is a manual run's target, when its last deploy is unknown, or when a path of its release
# changed since that deploy.
deploy() {
  local name="$1" since="${part_base[$1]}" path
  if [ "$deploy_ok" != true ]; then echo false; return; fi
  if [ "$event" = workflow_dispatch ] && { [ "$target" = all ] || [ "$target" = "$name" ]; }; then echo true; return; fi
  if ! known "$since"; then echo true; return; fi
  while IFS= read -r path; do
    case " $(parts_of "$path") " in
      *" $name "*) echo true; return ;;
    esac
  done < <(changed_since "$since")
  echo false
}

declare -A result=(
  [server_check]=$(check '^(server/|backend/src/auth\.py$|\.python-version$|uv\.lock$|\.github/)' && echo true || echo false)
  # The server's deploy scripts and the prop generator are tested with the character server's tests.
  [backend_check]=$(check '^(backend/|server/scripts/|scripts/props/|pyproject\.toml$|uv\.lock$|\.python-version$|\.dockerignore$|\.github/)' && echo true || echo false)
  [frontend_check]=$(check '^(frontend/|package\.json$|package-lock\.json$|\.nvmrc$|\.github/)' && echo true || echo false)
  [infra_check]=$(check '(^\.github/|/infra/|^server/scripts/|^scripts/|\.ps1$|\.sh$)' && echo true || echo false)
)
for name in server web studio; do
  result[deploy_$name]=$(deploy "$name")
done
# What is deployed is checked in the same run, even a change an earlier run already checked: the web release is the
# build of this run's check.
[ "${result[deploy_server]}" = false ] || result[server_check]=true
[ "${result[deploy_web]}" = false ] || result[frontend_check]=true
[ "${result[deploy_studio]}" = false ] || result[backend_check]=true

{
  echo "### 점검과 배포 대상"
  echo
  if [ "$event" = workflow_dispatch ]; then
    echo "수동 실행: 배포 대상 \`${target}\`와 마지막 배포 이후 바뀐 곳. 점검은 모두 돌립니다."
  elif known "$base"; then
    echo "점검 기준: \`${base:0:12}\` (모두 통과한 마지막 푸시 실행)"
  elif [ "$event" = push ]; then
    echo "비교할 이전 성공 실행이 없어 모두 점검합니다."
  fi
  echo
  echo "| 항목 | 실행 | 기준 |"
  echo "|---|---|---|"
  for key in server_check backend_check frontend_check infra_check; do
    echo "| ${key} | ${result[$key]} | |"
  done
  for name in server web studio; do
    since="${part_base[$name]}"
    echo "| deploy_${name} | ${result[deploy_$name]} | ${since:0:12} |"
  done
} >>"$summary"

for key in "${!result[@]}"; do
  echo "${key}=${result[$key]}" >>"$out"
done
