#!/usr/bin/env bash
# Decides which checks run and which parts are deployed, from the files changed since the last successful run.
# Environment: EVENT (pull_request | push | workflow_dispatch), REF, BASE (commit to diff against, empty when there is
# none), TARGET (the dispatch input: all | server | web | studio). Writes name=true|false lines to $GITHUB_OUTPUT.
set -euo pipefail

out="${GITHUB_OUTPUT:-/dev/stdout}"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
event="${EVENT:?EVENT is required}"
ref="${REF:-refs/heads/main}"
base="${BASE:-}"
target="${TARGET:-}"

has_base=false
if [ -n "$base" ] && git cat-file -e "$base^{commit}" 2>/dev/null; then has_base=true; fi

# Everything is checked when there is nothing to compare with and on a manual run.
all=false
files=
if [ "$event" = workflow_dispatch ] || [ "$has_base" = false ]; then
  all=true
else
  files=$(git diff --no-renames --name-only "$base" HEAD)
fi

# The first main push verifies and deploys all parts; later pushes compare against the last successful push.
deploy_ok=false
if [ "$ref" = refs/heads/main ]; then
  if [ "$event" = workflow_dispatch ] || [ "$event" = push ]; then deploy_ok=true; fi
fi

check() {
  [ "$all" = true ] || grep -Eq "$1" <<<"$files"
}

deploy() {
  local name="$1" pattern="$2" changed="$3"
  if [ "$deploy_ok" != true ]; then echo false; return; fi
  if [ "$event" = workflow_dispatch ]; then
    case "$target" in all | "$name") echo true ;; *) echo false ;; esac
  elif [ "$has_base" = false ]; then
    echo true
  elif grep -Eq "$pattern" <<<"$changed"; then
    echo true
  else
    echo false
  fi
}

# Tests do not change runtime artifacts; deployment scripts can change installed binaries or object metadata.
web_files=$(grep -Ev '/__tests__/|\.test\.|^frontend/infra/' <<<"$files" || true)
server_files=$(grep -Ev '^server/(tests|infra)/' <<<"$files" || true)
studio_files=$(grep -Ev '^backend/(tests/|AGENTS\.md|\.env\.example)' <<<"$files" || true)

declare -A result=(
  [server_check]=$(check '^(server/|backend/src/auth\.py$|\.python-version$|uv\.lock$|\.github/)' && echo true || echo false)
  [backend_check]=$(check '^(backend/|pyproject\.toml$|uv\.lock$|\.python-version$|\.dockerignore$|\.github/)' && echo true || echo false)
  [frontend_check]=$(check '^(frontend/|package\.json$|package-lock\.json$|\.github/)' && echo true || echo false)
  [infra_check]=$(check '(^\.github/|/infra/|^server/scripts/|^scripts/|\.ps1$|\.sh$)' && echo true || echo false)
  [deploy_server]=$(deploy server '^(server/(src/|migrations/|Cargo\.toml$|Cargo\.lock$|scripts/(bootstrap-rust-server|deploy-rust-server)\.py$)|\.github/workflows/pipeline\.yml$)' "$server_files")
  [deploy_web]=$(deploy web '^(frontend/(src/|public/|vendor/|vite/|scripts/deploy-aws\.ps1$|index\.html$|package\.json$|tsconfig\.json$|vite\.config\.ts$)|package\.json$|package-lock\.json$|\.github/workflows/pipeline\.yml$)' "$web_files")
  [deploy_studio]=$(deploy studio '^(backend/(src/|assets/|migrations/|infra/|pyproject\.toml$|main\.py$)|pyproject\.toml$|uv\.lock$|\.dockerignore$|\.github/workflows/pipeline\.yml$)' "$studio_files")
)

{
  echo "### 점검과 배포 대상"
  echo
  if [ "$event" = workflow_dispatch ]; then
    echo "수동 실행: 배포 대상 \`${target}\`, 점검은 모두 돌립니다."
  elif [ "$has_base" = true ]; then
    echo "비교 기준: \`${base:0:12}\` (마지막으로 성공한 실행)"
  elif [ "$event" = push ]; then
    echo "비교할 이전 성공 실행이 없어 모두 점검하고 배포합니다."
  fi
  echo
  echo "| 항목 | 실행 |"
  echo "|---|---|"
  for key in server_check backend_check frontend_check infra_check deploy_server deploy_web deploy_studio; do
    echo "| ${key} | ${result[$key]} |"
  done
} >>"$summary"

for key in "${!result[@]}"; do
  echo "${key}=${result[$key]}" >>"$out"
done
