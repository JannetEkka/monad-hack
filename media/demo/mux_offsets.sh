#!/usr/bin/env bash
# Lay scene audio at the offsets the recorder logged, then mux onto the recording.
# usage: mux_offsets.sh <offsets.json> <audio_dir> <out.mp4>
set -euo pipefail
json=$1; audio=$2; out=$3
video=$(python3 -c "import json;print(json.load(open('$json'))['video'])")
args=(); filt=""; i=0
for off in $(python3 -c "import json;print(' '.join(str(x) for x in json.load(open('$json'))['offsets']))"); do
  n=$((i+1)); args+=(-i "$audio/scene$(printf %02d $n).mp3")
  ms=$(python3 -c "print(int($off*1000))")
  filt+="[$((i+1)):a]adelay=${ms}|${ms}[a$i];"; i=$n
done
mix=""; for ((k=0;k<i;k++)); do mix+="[a$k]"; done
filt+="${mix}amix=inputs=$i:normalize=0[aout]"
ffmpeg -y -loglevel error -i "$video" "${args[@]}" -filter_complex "$filt" -map 0:v -map "[aout]" \
  -c:v libx264 -preset veryfast -crf 22 -pix_fmt yuv420p -r 30 -c:a aac -b:a 160k -ar 48000 "$out"
ffprobe -v error -show_entries format=duration -of csv=p=0 "$out"
