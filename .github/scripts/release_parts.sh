# Sourced by changes.sh (and its tests): which releases a repository path is part of.
# Anything new under server/, frontend/ or backend/ is deployed unless it is known not to run there, so a new build input
# is never skipped. backend/infra/prepare-aws.ps1 ($releasePaths) packs the studio release; test_changes.py keeps the two
# in step.

# Prints the parts (server, web, studio) whose release holds `$1`; nothing for a path no release holds.
parts_of() {
  case "$1" in
    *.md) ;;
    .github/workflows/pipeline.yml) echo server web studio ;;
    server/scripts/bootstrap-rust-server.py | server/scripts/deploy-rust-server.py) echo server ;;
    server/tests/* | server/infra/* | server/examples/* | server/scripts/* | server/docker-compose.yml | server/rustfmt.toml | server/.env.example) ;;
    server/*) echo server ;;
    frontend/scripts/deploy-aws.ps1) echo web ;;
    frontend/infra/* | frontend/scripts/* | frontend/*/__tests__/* | frontend/*.test.* | frontend/vendor/*.patch | frontend/vendor/*.json) ;;
    frontend/* | package.json | package-lock.json | .nvmrc) echo web ;;
    backend/tests/* | backend/.env.example | backend/Dockerfile) ;;
    backend/* | pyproject.toml | uv.lock | .dockerignore) echo studio ;;
  esac
}
