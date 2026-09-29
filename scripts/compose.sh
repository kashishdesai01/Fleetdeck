#!/bin/sh
set -eu
# Homebrew Docker can retain a Docker Desktop credential helper after Desktop is removed.
# Fleetdeck uses public base images; keep any fallback configuration local to this project.
if [ -z "${DOCKER_CONFIG:-}" ] && [ -f "$HOME/.docker/config.json" ]; then
  fleetdeck_helper=$(node -e 'try { const fs=require("node:fs"); const os=require("node:os"); const c=JSON.parse(fs.readFileSync(os.homedir()+"/.docker/config.json","utf8")); process.stdout.write(c.credsStore || ""); } catch {}')
  if [ -n "$fleetdeck_helper" ] && ! command -v "docker-credential-$fleetdeck_helper" >/dev/null 2>&1; then
    fleetdeck_endpoint=${DOCKER_HOST:-$(docker context inspect --format '{{(index .Endpoints "docker").Host}}')}
    mkdir -p .local/docker-public
    if [ ! -f .local/docker-public/config.json ]; then
      printf '{"auths":{}}\n' > .local/docker-public/config.json
    fi
    export DOCKER_CONFIG="$PWD/.local/docker-public"
    export DOCKER_HOST="$fleetdeck_endpoint"
    echo 'Docker credential helper unavailable; using project-local public-image configuration.' >&2
  fi
fi
if docker compose version >/dev/null 2>&1; then
  exec docker compose "$@"
elif command -v docker-compose >/dev/null 2>&1; then
  exec docker-compose "$@"
else
  echo 'Docker Compose is required. Install the Compose plugin or docker-compose.' >&2
  exit 1
fi
