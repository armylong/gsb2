#!/usr/bin/env bash
# 生成 60 秒 HLS 点播样例：三档互相对齐的码率（GOP 对齐、4 秒分片），
# 画面带大号秒数与移动图形（testsrc2 自带移动元素与时间戳）。
# 用法: bash scripts/generate-media.sh
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="media/sample"

rm -rf "$OUT"
mkdir -p "$OUT"

# 画面内容：testsrc2 自带秒数时间戳与动态元素，再叠加一个每秒移动的红色方块，
# 便于肉眼确认“当前播放到第几秒、画面是否连续”。
# 三档共用同一源、相同 GOP（-g 120 = 4s@30fps），保证分片边界与关键帧对齐，
# 清晰度切换时画面时间连续。
ffmpeg -hide_banner -loglevel warning -y \
  -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=60" \
  -f lavfi -i "sine=frequency=440:sample_rate=44100:duration=60" \
  -filter_complex "\
[0:v]split=3[sa][sb][sc];\
color=c=red:size=96x96:duration=60:rate=30,split=3[q1][q2][q3];\
[sa]scale=640:360[ba];[ba][q1]overlay=x='mod(t*150\,W-w)':y='H-h-24'[va];\
[sb]scale=854:480[bb];[bb][q2]overlay=x='mod(t*150\,W-w)':y='H-h-24'[vb];\
[sc]scale=1280:720[bc];[bc][q3]overlay=x='mod(t*150\,W-w)':y='H-h-24'[vc]" \
  -map "[va]" -map 1:a -c:v:0 libx264 -preset veryfast -b:v:0 400k  -maxrate:v:0 480k  -bufsize:v:0 800k  -c:a:0 aac -b:a:0 64k \
  -map "[vb]" -map 1:a -c:v:1 libx264 -preset veryfast -b:v:1 900k  -maxrate:v:1 1000k -bufsize:v:1 1800k -c:a:1 aac -b:a:1 96k \
  -map "[vc]" -map 1:a -c:v:2 libx264 -preset veryfast -b:v:2 1800k -maxrate:v:2 2000k -bufsize:v:2 3600k -c:a:2 aac -b:a:2 128k \
  -g 120 -keyint_min 120 -sc_threshold 0 \
  -f hls -hls_time 4 -hls_playlist_type vod -hls_flags independent_segments \
  -var_stream_map "v:0,a:0 v:1,a:1 v:2,a:2" \
  -master_pl_name master.m3u8 \
  -hls_segment_filename "$OUT/v%v/segment_%03d.ts" \
  "$OUT/v%v/index.m3u8"

echo "生成完成: $OUT/master.m3u8"
ls "$OUT"
