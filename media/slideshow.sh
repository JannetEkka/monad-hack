#!/usr/bin/env bash
# Slides + per-scene narration -> one MP4 (H.264 + AAC).
# usage: slideshow.sh <slides_dir> <audio_dir> <out.mp4> <slide numbers, one per scene...>
set -euo pipefail
slides=$1; audio=$2; out=$3; shift 3
work=$(mktemp -d); list="$work/list.txt"; i=1
for n in "$@"; do
  a="$audio/scene$(printf %02d $i).mp3"
  d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$a")
  dur=$(python3 -c "print(round($d + 0.6, 2))"); fo=$(python3 -c "print(round($d + 0.25, 2))")
  ffmpeg -y -loglevel error -loop 1 -framerate 30 -i "$slides/$(printf %02d $n).png" -i "$a" \
    -filter_complex "[0:v]scale=1920:1080,format=yuv420p,fade=t=in:st=0:d=0.3,fade=t=out:st=$fo:d=0.35[v];[1:a]apad=pad_dur=0.6[a]" \
    -map "[v]" -map "[a]" -t "$dur" -c:v libx264 -preset veryfast -crf 20 -r 30 -c:a aac -b:a 160k -ar 48000 "$work/c$i.mp4"
  echo "file '$work/c$i.mp4'" >> "$list"; i=$((i+1))
done
ffmpeg -y -loglevel error -f concat -safe 0 -i "$list" -c copy "$out"
rm -rf "$work"
ffprobe -v error -show_entries format=duration -of csv=p=0 "$out"
