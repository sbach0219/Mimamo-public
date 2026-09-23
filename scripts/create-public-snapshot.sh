#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/public-files.txt"
DEST="${1:-}"

if [[ -z "$DEST" ]]; then
  echo "usage: $0 <empty-output-directory>" >&2
  exit 2
fi

if [[ "$DEST" != /* ]]; then
  DEST="$(pwd)/$DEST"
fi

# Resolve aliases and .. before checking the repository boundary.
DEST="$(node -e '
const fs = require("fs"), path = require("path");
let p = path.resolve(process.argv[1]);
const suffix = [];
while (!fs.existsSync(p)) { suffix.unshift(path.basename(p)); p = path.dirname(p); }
console.log(path.join(fs.realpathSync(p), ...suffix));
' "$DEST")"

case "$DEST" in
  "$ROOT"|"$ROOT"/*)
    echo "output directory must be outside the source repository" >&2
    exit 2
    ;;
esac

if [[ -e "$DEST" ]] && [[ -n "$(find "$DEST" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
  echo "output directory must be empty: $DEST" >&2
  exit 2
fi

mkdir -p "$DEST"

ALLOW=()
while IFS= read -r entry; do
  [[ -z "$entry" || "$entry" == \#* ]] && continue
  if [[ "$entry" == /* || "$entry" == *".."* ]]; then
    echo "unsafe manifest entry: $entry" >&2
    exit 2
  fi

  source_path="$ROOT/$entry"
  target_path="$DEST/$entry"
  if [[ ! -e "$source_path" ]]; then
    echo "manifest entry does not exist: $entry" >&2
    exit 2
  fi
  ALLOW+=("$entry")
done < "$MANIFEST"

# Copy files one by one from Git's tracked/untracked inventory. This deliberately
# excludes ignored build products, dependencies, logs, local environment files,
# and editor metadata even when an allowlisted source directory contains them.
while IFS= read -r -d '' source_rel; do
  allowed=false
  for entry in "${ALLOW[@]}"; do
    if [[ "$source_rel" == "$entry" || "$source_rel" == "$entry/"* ]]; then
      allowed=true
      break
    fi
  done
  [[ "$allowed" == false ]] && continue

  source_path="$ROOT/$source_rel"
  target_path="$DEST/$source_rel"
  if [[ -L "$source_path" ]]; then
    echo "refusing to export symlink: $source_rel" >&2
    exit 2
  fi
  mkdir -p "$(dirname "$target_path")"
  cp -Pp "$source_path" "$target_path"
done < <(git -C "$ROOT" ls-files --cached --others --exclude-standard -z)

# A public source snapshot must not point forks at the owner's EAS project,
# production update channel, App Store account, or Apple developer team.
node - "$DEST/app.json" "$DEST/eas.json" "$DEST/docs/universal-links-setup.md" <<'NODE'
const fs = require('fs');

const [appPath, easPath, universalLinksPath] = process.argv.slice(2);
const app = JSON.parse(fs.readFileSync(appPath, 'utf8'));
const appleTeamId = app.expo.ios?.appleTeamId;
delete app.expo.owner;
delete app.expo.updates;
delete app.expo.ios?.appleTeamId;
if (app.expo.extra?.eas) {
  delete app.expo.extra.eas.projectId;
  if (Object.keys(app.expo.extra.eas).length === 0) delete app.expo.extra.eas;
}
if (app.expo.extra && Object.keys(app.expo.extra).length === 0) delete app.expo.extra;
fs.writeFileSync(appPath, `${JSON.stringify(app, null, 2)}\n`);

const eas = JSON.parse(fs.readFileSync(easPath, 'utf8'));
delete eas.submit;
fs.writeFileSync(easPath, `${JSON.stringify(eas, null, 2)}\n`);

const universalLinks = fs.readFileSync(universalLinksPath, 'utf8');
fs.writeFileSync(
  universalLinksPath,
  appleTeamId
    ? universalLinks.replaceAll(appleTeamId, 'YOUR_APPLE_TEAM_ID')
    : universalLinks,
);
NODE

echo "public snapshot created at: $DEST"
echo "review it before initializing Git or publishing"
