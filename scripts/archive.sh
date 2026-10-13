#!/usr/bin/env bash
# Push the snapshots the keeper sealed (archive-out/batches/*.json) to the `archive` branch.
# Safe to call after every keeper pass: it starts from a fresh worktree each time and
# commits only what changed.
set -euo pipefail
src=${ARCHIVE_DIR:-archive-out}/batches
[ -d "$src" ] && [ -n "$(ls -A "$src")" ] || { echo "nothing to archive"; exit 0; }
git config user.name "smt-receipts-keeper"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
wt=$(mktemp -d)/archive
if git ls-remote --exit-code --heads origin archive >/dev/null; then
  git fetch -q --depth 1 origin archive
  git worktree add -q "$wt" FETCH_HEAD
  git -C "$wt" checkout -q -B archive
else
  git worktree add -q --detach "$wt"
  git -C "$wt" checkout -q --orphan archive
  git -C "$wt" rm -rf --quiet . || true
  printf '# SMT Receipts archive\n\nThe exact SMT World snapshot each batch sealed, written by the keeper.\n`keccak256(source.raw)` equals the batch'"'"'s on-chain snapshotHash; each receipt'"'"'s `canonical` hashes to its reasonHash.\n' > "$wt/README.md"
fi
mkdir -p "$wt/batches"
cp "$src"/*.json "$wt/batches/"
git -C "$wt" add -A
if git -C "$wt" diff --cached --quiet; then echo "archive up to date"; else
  git -C "$wt" commit -q -m "archive: batch $(git -C "$wt" diff --cached --name-only -- batches | sed 's#batches/##; s#.json##' | tr '\n' ' ')"
  git -C "$wt" push -q origin archive
  echo "archived"
fi
git worktree remove --force "$wt"
