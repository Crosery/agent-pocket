#!/usr/bin/env bash
# Runs on the server as the deploy user once CI has uploaded a release: install runtime deps, switch `current`
# atomically, restart, wait until /release.json reports this commit, otherwise roll back to the previous release.
set -euo pipefail
ENV=$1 SHA=$2 KEEP=${KEEP:-5} WAIT=${WAIT:-120}
BASE=/srv/ap/$ENV
PORT=$(sed -n 's/^PORT=//p' "/srv/ap/$ENV.env")
PREV=$(readlink "$BASE/current" 2>/dev/null || true)
log() { echo "$(date -Is) $*" | tee -a "$BASE/deploy-history.log"; }
activate() { ln -sfn "$1" "$BASE/current.next" && mv -T "$BASE/current.next" "$BASE/current" && sudo /usr/bin/systemctl restart "ap@$ENV"; }
# The server builds the world at boot (~25 s on this host), so allow a generous wait.
healthy() { for _ in $(seq "$WAIT"); do curl -fsS "http://127.0.0.1:$PORT/release.json" 2>/dev/null | grep -q "\"commit\":\"$1\"" && return 0; sleep 1; done; return 1; }

cd "$BASE/releases/$SHA"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error
activate "releases/$SHA"
if healthy "$SHA"; then
  log "deployed $SHA"
  ls -1dt "$BASE"/releases/*/ | tail -n +$((KEEP + 1)) | xargs -r rm -rf
else
  log "FAILED $SHA, rolled back to ${PREV:-nothing}"
  [ -n "$PREV" ] && activate "$PREV"
  exit 1
fi
