#!/usr/bin/env bash
# Manual rollback on the server: ssh ap@<host> bash /srv/ap/<env>/current/deploy/rollback.sh <env> [sha]
# Without a sha it returns to the release deployed before the current one (deploy-history.log). Tags are never moved.
set -euo pipefail
ENV=$1 BASE=/srv/ap/$1
CUR=$(basename "$(readlink "$BASE/current")")
TO=${2:-$(grep ' deployed ' "$BASE/deploy-history.log" | awk '{print $3}' | grep -vx "$CUR" | tail -n1)}
[ -n "$TO" ] && [ -d "$BASE/releases/$TO" ] || { echo "no release to roll back to (have: $(ls "$BASE/releases"))" >&2; exit 1; }
ln -sfn "releases/$TO" "$BASE/current.next" && mv -T "$BASE/current.next" "$BASE/current"
sudo /usr/bin/systemctl restart "ap@$ENV"
echo "$(date -Is) rollback $CUR -> $TO" | tee -a "$BASE/deploy-history.log"
