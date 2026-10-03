#!/usr/bin/env bash
# Decides where a release tag deploys and refuses anything that breaks the release rules (docs/RELEASING.md).
# Prints key=value lines for $GITHUB_OUTPUT. Needs full history and tags (actions/checkout fetch-depth: 0).
set -euo pipefail
TAG=$1
die() { echo "::error::$*" >&2; exit 1; }
[[ $TAG =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-rc\.([1-9][0-9]*))?$ ]] || die "$TAG is not vX.Y.Z or vX.Y.Z-rc.N"
VERSION=${TAG#v}; BASE_VERSION=${VERSION%%-rc.*}
SHA=$(git rev-list -n1 "$TAG")
PKG=$(git show "$TAG:package.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')
[ "$PKG" = "$BASE_VERSION" ] || die "$TAG does not match package.json version $PKG at that commit"
git fetch -q origin stage main
if [ -n "${BASH_REMATCH[4]}" ]; then
  ENV=preview
  git merge-base --is-ancestor "$SHA" origin/stage || die "rc tags must point at a commit on stage"
else
  ENV=production
  git merge-base --is-ancestor "$SHA" origin/main || die "release tags must point at a commit on main (git merge --ff-only <rc tag>)"
  git tag --points-at "$SHA" | grep -qE "^v${BASE_VERSION//./\\.}-rc\.[0-9]+$" || die "no v$BASE_VERSION-rc.N on $SHA: ship it to preview first"
  PREV_ORIGIN=$(node -p 'require("./deploy/environments.json").preview.origin')
  LIVE=$(curl -fsS --max-time 15 "$PREV_ORIGIN/release.json" | node -p 'JSON.parse(require("fs").readFileSync(0)).commit' || true)
  [ "$LIVE" = "$SHA" ] || die "preview runs ${LIVE:-unknown}, not $SHA: production only ships what preview verified"
fi
echo "environment=$ENV"
echo "origin=$(node -p "require('./deploy/environments.json').$ENV.origin")"
echo "sha=$SHA"
echo "version=$VERSION"
