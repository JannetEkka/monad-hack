#!/usr/bin/env bash
# Builds the submission media from the LIVE contract and page, using the narration already in
# media/*/audio (made with Kokoro from media/*/script.txt):
#   deck/slides + deck/SMT-Receipts-deck.pdf   (slide 8 = live numbers for both agents)
#   media/pitch/SMT-Receipts-pitch.mp4         (≤ 2 min)
#   media/demo/SMT-Receipts-demo.mp4           (≤ 3 min, the live page recorded in Chromium)
# usage: bash media/make-media.sh [work_dir]
set -euo pipefail
cd "$(dirname "$0")/.."
work=${1:-$(mktemp -d)}
mkdir -p "$work"
page="https://jannetekka.github.io/monad-hack/"
archive="https://github.com/JannetEkka/monad-hack/commits/archive"

# playwright, outside the repo (it is not a dependency of the project)
pw="$work/pw"
if [ ! -d "$pw/node_modules/playwright" ]; then
  mkdir -p "$pw" && (cd "$pw" && npm init -y >/dev/null && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i --silent playwright >/dev/null)
fi

echo "── deck"
cp media/demo/shot-detail.mjs "$pw/shot-detail.mjs"
node "$pw/shot-detail.mjs" "$page" deck/img/page-detail.png
PLAYWRIGHT_MODULE="$pw/node_modules/playwright" node deck/build.js --render

echo "── pitch"
bash media/slideshow.sh deck/slides media/pitch/audio media/pitch/SMT-Receipts-pitch.mp4 1 2 3 5 6 7 8 9 10

echo "── demo"
rm -rf "$work/rec" && mkdir -p "$work/rec"
cp media/demo/record.mjs "$pw/record.mjs"
node "$pw/record.mjs" "$page" "$archive" media/demo/audio "$work/rec"
bash media/demo/mux_offsets.sh "$work/rec/offsets.json" media/demo/audio media/demo/SMT-Receipts-demo.mp4
