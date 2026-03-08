#!/usr/bin/env bash
set -euo pipefail

TARGET_BRANCH="test"

current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$current_branch" != "$TARGET_BRANCH" ]]; then
  echo "ERROR: current branch is '$current_branch', expected '$TARGET_BRANCH'."
  echo "Switch branch first: git checkout $TARGET_BRANCH"
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "WARN: working tree has uncommitted changes."
  echo "These changes will NOT be included unless committed first."
fi

echo "Fetching origin/$TARGET_BRANCH..."
git fetch origin "$TARGET_BRANCH"

local_sha="$(git rev-parse "$TARGET_BRANCH")"
remote_sha="$(git rev-parse "origin/$TARGET_BRANCH")"

echo "Local  $TARGET_BRANCH SHA: $local_sha"
echo "Remote $TARGET_BRANCH SHA: $remote_sha"

if [[ "$local_sha" != "$remote_sha" ]]; then
  echo "Pushing $TARGET_BRANCH to origin..."
  git push origin "$TARGET_BRANCH"
fi

echo "Verifying remote SHA after push..."
git fetch origin "$TARGET_BRANCH"
local_sha_after="$(git rev-parse "$TARGET_BRANCH")"
remote_sha_after="$(git rev-parse "origin/$TARGET_BRANCH")"

echo "Local  $TARGET_BRANCH SHA (after): $local_sha_after"
echo "Remote $TARGET_BRANCH SHA (after): $remote_sha_after"

if [[ "$local_sha_after" != "$remote_sha_after" ]]; then
  echo "ERROR: remote SHA mismatch after push."
  exit 1
fi

echo "OK: deploy source synchronized. APP_GIT_SHA=$local_sha_after"
