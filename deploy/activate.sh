#!/usr/bin/env bash
# Runs ON THE VM after a release directory was uploaded: installs runtime dependencies, flips the `current` symlink,
# restarts the service, checks /health and rolls back to the previous release when it does not come up.
#   usage: activate.sh /opt/voltline/releases/<id>
set -euo pipefail

release="${1:?release directory}"
base="$(dirname "$(dirname "$release")")" # /opt/voltline
port="${PORT:-8080}"
service="${SERVICE:-voltline-server}"

for f in dist-server/index.mjs data/colliders package.json package-lock.json; do
  [ -e "$release/$f" ] || { echo "release is missing $f" >&2; exit 1; }
done

# Runtime dependencies only (ws, three, rapier): the bundle imports them as externals.
(cd "$release" && npm ci --omit=dev --no-audit --no-fund)

previous="$(readlink -f "$base/current" || true)"
ln -sfn "$release" "$base/current.new"
mv -Tf "$base/current.new" "$base/current"
sudo systemctl restart "$service"

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$port/health" > /dev/null; then
    echo "healthy: $(basename "$release")"
    # Keep the last 4 releases for rollback.
    ls -1dt "$base"/releases/*/ | tail -n +5 | xargs -r rm -rf
    exit 0
  fi
  sleep 1
done

echo "health check failed; rolling back" >&2
if [ -n "$previous" ] && [ -d "$previous" ]; then
  ln -sfn "$previous" "$base/current.new"
  mv -Tf "$base/current.new" "$base/current"
  sudo systemctl restart "$service"
fi
exit 1
