#!/usr/bin/env bash
# Release the Desktop-side plugin (experiments/mirror/mirror, published as @herenfor/dsh-wsl).
#
#   scripts/release.sh <version>            test, assemble, set the version, commit, tag v<version>, push;
#                                           the tag starts .github/workflows/publish.yml, which publishes to npm
#   scripts/release.sh <version> --local    the same, then publish from this machine (needs `npm login`); for the
#                                           first release, before npm's trusted publisher is set up for the package
#   scripts/release.sh <version> --dry-run  test, assemble and show what would be published; changes nothing
#
# A version with a pre-release part (0.2.0-beta.1) is published under the npm tag `next`, so `latest` stays on the
# last release. Installed copies update themselves from npm (selfupdate.mjs).
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
pkg="$here/experiments/mirror/mirror"
version="${1:-}"
mode="${2:-push}"
case "$mode" in push|--local|--dry-run) ;; *) echo "unknown option: $mode" >&2; exit 2 ;; esac
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "usage: scripts/release.sh <version> [--local | --dry-run]   (version like 0.1.1 or 0.2.0-beta.1)" >&2
  exit 2
fi
step() { printf '\n== %s\n' "$*"; }
cd "$here"

name="$(node -p "require('$pkg/package.json').name")"
current="$(node -p "require('$pkg/package.json').version")"
tag="v$version"
npm_tag=latest; [[ "$version" == *-* ]] && npm_tag=next

step "checks"
if [ "$mode" != --dry-run ]; then
  [ "$(git branch --show-current)" = main ] || { echo "release from main (now on $(git branch --show-current))" >&2; exit 1; }
  [ -z "$(git status --porcelain)" ] || { echo "the working tree has uncommitted changes; commit or stash them first" >&2; exit 1; }
  git fetch -q origin main --tags
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "main differs from origin/main; pull or push first" >&2; exit 1; }
  ! git rev-parse -q --verify "refs/tags/$tag" >/dev/null || { echo "tag $tag already exists" >&2; exit 1; }
fi
if published="$(npm view "$name@$version" version 2>/dev/null)" && [ -n "$published" ]; then
  echo "$name@$version is already on npm" >&2; exit 1
fi
echo "$name $current -> $version (npm tag: $npm_tag)"

step "tests"
node --test experiments/mirror/tests/*.test.mjs 2>&1 | grep -E '^ℹ (pass|fail)|^not ok|✖' || true
node --test experiments/mirror/tests/*.test.mjs >/dev/null 2>&1 || { echo "tests failed" >&2; exit 1; }

step "assemble the package"
scripts/assemble.sh

step "package contents"
( cd "$pkg" && npm pack --dry-run --json 2>/dev/null ) | node -e '
  const files = JSON.parse(require("fs").readFileSync(0, "utf8"))[0].files.map((f) => f.path)
  const need = ["package.json", "index.mjs", "client.js", "cordis.patch.yml", "icon.svg", "README.md", "README.zh.md", "LICENSE",
    "locale/en.json", "locale/zh.json", "transport/daemon.mjs", "transport/mux.mjs", "transport/client.mjs", "agent/index.mjs", "agent/package.json"]
  const missing = need.filter((f) => !files.includes(f))
  console.log(`${files.length} files`)
  if (missing.length) { console.error(`missing from the package: ${missing.join(", ")}`); process.exit(1) }'

if [ "$mode" = --dry-run ]; then
  if [ -n "$(git status --porcelain -- "$pkg")" ]; then
    step "assembling changed these files (a real release commits them)"
    git status --short -- "$pkg"
  fi
  step "dry run done: nothing committed, tagged, pushed or published"
  exit 0
fi

step "version $version"
[ "$version" = "$current" ] && echo "package.json is already at $version (a first release)" || node -e '
  const fs = require("fs"); const p = process.argv[1]
  const pkg = JSON.parse(fs.readFileSync(p, "utf8")); pkg.version = process.argv[2]
  fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n")' "$pkg/package.json" "$version"

step "commit and tag $tag"
git add -- "$pkg"
git diff --cached --quiet || git commit -q -m "Release $name $version"
git tag -a "$tag" -m "$name $version"

if [ "$mode" = --local ]; then
  # Published before the tag goes up, so the workflow the tag starts finds it on npm and skips.
  step "publish from this machine"
  ( cd "$pkg" && npm publish --access public --tag "$npm_tag" ) || {
    echo "npm publish failed; the commit and tag $tag stay local. Fix it and run: (cd $pkg && npm publish --access public --tag $npm_tag) && git push origin main $tag" >&2
    exit 1
  }
fi
git push -q origin main "$tag"
echo "pushed main and $tag"
[ "$mode" = --local ] && echo "published $name@$version from this machine" || echo "GitHub Actions publishes $name@$version: https://github.com/herenfor/dsh-wsl/actions"
