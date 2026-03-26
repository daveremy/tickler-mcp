#!/usr/bin/env bash
set -euo pipefail

# Release script for tickler-mcp
# Usage: ./scripts/release.sh <patch|minor|major>
#
# Steps:
# 1. Enforce main branch and clean working tree
# 2. Bump version in package.json
# 3. Sync version to src/version.ts, .claude-plugin/plugin.json, .claude-plugin/marketplace.json
# 4. Update CHANGELOG.md [Unreleased] -> new version with today's date
# 5. Build and verify with npm pack --dry-run
# 6. Commit and tag
# 7. Publish to npm FIRST (before pushing to GitHub)
# 8. Push to GitHub
# 9. Update ~/code/claude-plugins aggregated marketplace

BUMP=${1:-}
if [[ -z "$BUMP" || ! "$BUMP" =~ ^(patch|minor|major)$ ]]; then
  echo "Usage: $0 <patch|minor|major>"
  exit 1
fi

# Enforce main branch
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != "main" ]]; then
  echo "Error: must be on main branch to release (currently on '$BRANCH')"
  exit 1
fi

# Enforce clean working tree
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean. Commit or stash changes first."
  exit 1
fi

# Bump version in package.json (no git tag, no commit yet)
OLD_VERSION=$(node -p "require('./package.json').version")
npm version "$BUMP" --no-git-tag-version --no-commit-hooks > /dev/null
NEW_VERSION=$(node -p "require('./package.json').version")

echo "Bumping $OLD_VERSION -> $NEW_VERSION"

# Sync version to all files using node -e (portable — no sed -i BSD/GNU incompatibility)
node -e "
const fs = require('fs');
const v = '$NEW_VERSION';

// src/version.ts
const vf = 'src/version.ts';
const vc = fs.readFileSync(vf, 'utf8');
const updated = vc.replace(/export const VERSION = \"[^\"]*\"/, \`export const VERSION = \"\${v}\"\`);
if (vc === updated) { console.error('Failed to update src/version.ts'); process.exit(1); }
fs.writeFileSync(vf, updated);

// .claude-plugin/plugin.json
const pf = '.claude-plugin/plugin.json';
const pj = JSON.parse(fs.readFileSync(pf, 'utf8'));
pj.version = v;
fs.writeFileSync(pf, JSON.stringify(pj, null, 2) + '\n');

// .claude-plugin/marketplace.json
const mf = '.claude-plugin/marketplace.json';
const mj = JSON.parse(fs.readFileSync(mf, 'utf8'));
mj.plugins[0].version = v;
fs.writeFileSync(mf, JSON.stringify(mj, null, 2) + '\n');

console.log('Version synced to version.ts, plugin.json, marketplace.json');
"

# Update CHANGELOG.md: move [Unreleased] entries to new versioned section
TODAY=$(date +%Y-%m-%d)
node -e "
const fs = require('fs');
const cf = 'CHANGELOG.md';
let content = fs.readFileSync(cf, 'utf8');
const v = '$NEW_VERSION';
const today = '$TODAY';
const oldV = '$OLD_VERSION';

// Replace '## [Unreleased]' with '## [Unreleased]\n\n## [NEW_VERSION] - DATE'
content = content.replace(
  /## \[Unreleased\]/,
  \`## [Unreleased]\n\n## [\${v}] - \${today}\`
);

// Update the [Unreleased] compare link — handles both /commits/main and /compare/vX.Y.Z...HEAD
// Use [^\s]+ to match full semver with dots (e.g. v1.0.1...HEAD)
content = content.replace(
  /\[Unreleased\]: (https:\/\/github\.com\/[^\/]+\/[^\/]+)\/(compare\/v[^\s]+\.\.\.|commits\/)[^\s]*/,
  \`[Unreleased]: \$1/compare/v\${v}...HEAD\`
);

// Add the new version compare link before the old version link
const oldLink = \`[\${oldV}]:\`;
const newLink = \`[\${v}]: https://github.com/daveremy/tickler-mcp/compare/v\${oldV}...v\${v}\`;
if (content.includes(oldLink)) {
  content = content.replace(oldLink, \`\${newLink}\n\${oldLink}\`);
} else {
  // First versioned link — append at end
  content = content.trimEnd() + \`\n[\${v}]: https://github.com/daveremy/tickler-mcp/releases/tag/v\${v}\n\`;
}

fs.writeFileSync(cf, content);
console.log('CHANGELOG.md updated');
"

# Build and verify
echo "Building..."
npm run build

echo "Verifying package contents..."
npm pack --dry-run

echo ""
read -p "Publish tickler-mcp@$NEW_VERSION to npm? [y/N] " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted. Version files updated but not committed."
  exit 1
fi

# Commit and tag
git add package.json package-lock.json src/version.ts .claude-plugin/plugin.json .claude-plugin/marketplace.json CHANGELOG.md
git commit -m "Release v$NEW_VERSION"
git tag "v$NEW_VERSION"

# Publish to npm FIRST (before pushing to GitHub)
# If publish fails, the commit/tag are local only — easy to recover
npm publish --access public

echo "Published tickler-mcp@$NEW_VERSION"

# Push to GitHub AFTER successful publish
git push origin main
git push origin "v$NEW_VERSION"

echo "Pushed to GitHub"

# Update aggregated marketplace — optional, non-fatal (release is already complete above)
update_aggregated_marketplace() {
  local CLAUDE_PLUGINS_DIR="$HOME/code/claude-plugins"
  if [[ ! -d "$CLAUDE_PLUGINS_DIR" ]]; then
    echo "Warning: $CLAUDE_PLUGINS_DIR not found — update aggregated marketplace manually"
    return
  fi

  echo "Updating aggregated marketplace..."
  cd "$CLAUDE_PLUGINS_DIR"
  git pull --quiet

  node -e "
  const fs = require('fs');
  const mf = '.claude-plugin/marketplace.json';
  const mj = JSON.parse(fs.readFileSync(mf, 'utf8'));
  const v = '$NEW_VERSION';
  const plugin = mj.plugins.find(p => p.name === 'tickler-mcp');
  if (plugin) {
    plugin.version = v;
    console.log('Updated tickler-mcp version to ' + v + ' in aggregated marketplace');
  } else {
    mj.plugins.push({
      name: 'tickler-mcp',
      source: { source: 'npm', package: 'tickler-mcp' },
      description: 'Persistent ticklers/reminders that survive agent session restarts',
      version: v
    });
    console.log('Added tickler-mcp ' + v + ' to aggregated marketplace');
  }
  fs.writeFileSync(mf, JSON.stringify(mj, null, 2) + '\n');
  "

  git add .claude-plugin/marketplace.json
  git commit -m "Update tickler-mcp to v$NEW_VERSION"
  git push origin main

  echo "Aggregated marketplace updated"
  cd - > /dev/null
}

# Run marketplace update in a subshell so failures don't abort after successful publish
(update_aggregated_marketplace) || echo "Warning: aggregated marketplace update failed — update $HOME/code/claude-plugins manually"

echo ""
echo "Release v$NEW_VERSION complete."
