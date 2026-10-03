#!/usr/bin/env bash
# Runs on the server as the deploy user after CI has uploaded a release: install runtime deps,
# switch the env's `current` symlink atomically, restart, health-check, keep the last few releases.
set -euo pipefail
ENV=$1 SHA=$2 KEEP=${KEEP:-3}
BASE=/srv/ap/$ENV
PORT=$(sed -n 's/^PORT=//p' "/srv/ap/$ENV.env")
cd "$BASE/releases/$SHA"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error
ln -sfn "releases/$SHA" "$BASE/current.next" && mv -T "$BASE/current.next" "$BASE/current"
sudo /usr/bin/systemctl restart "ap@$ENV"
curl -fsS --retry 15 --retry-delay 1 --retry-connrefused -o /dev/null "http://127.0.0.1:$PORT/"
ls -1dt "$BASE"/releases/*/ | tail -n +$((KEEP + 1)) | xargs -r rm -rf
echo "deployed $SHA to $ENV"
