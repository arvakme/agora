#!/usr/bin/env bash
# Agora 宣传片：从 docs/promo/film/ 的源文件拼出一个 huashu-motion 项目，备好素材和音效，渲染成片。
#
#   OM=/path/to/huashu-motion/cli/om.js  EARSHOT=/path/to/earshot/.venv/bin/earshot \
#   FOOTAGE=/mnt/project-files/agora-motion-video  bash docs/promo/build.sh [build-dir] [prep|render|finish|all] [zh|en|both]
#
# 同一个合成稿，语言是变量 lang：每种语言渲染一遍，出 out/agora-promo.<lang>.mp4（完整画质）和
# out/agora-promo.<lang>.web.mp4（≤ 9.5 MB，README 内嵌用；仓库里的 docs/media/agora-promo.<lang>.mp4 就是这一版）。
#
# 依赖（都不进本仓库）：
# - huashu-motion（github.com/alchaincyf/huashu-motion，MIT）：om new / sound / check / render / qa。
#   它自带 GSAP 和运行时 vendor/om.js，由 `om new` 拷进构建目录。OM_CHROME 指向一个 Chromium。
# - earshot（github.com/Leonxlnx/earshot，MIT）：从它代码里的音效库渲染转场 whoosh、按键和结尾 sting，
#   只用不需要模型的 sfx 命令。
# - FOOTAGE：Agora 实录的画面（录制脚本在 web/scripts/*-capture.ts），这里只裁切、不改内容。
# - 展示字体 Instrument Serif、Noto Serif SC（OFL）：prep 时 webfonts.py 从 Google Fonts 取，中文按文案取子集。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
BUILD="${1:-$HERE/.build}"
STEP="${2:-all}"
LANGS="${3:-both}"; [ "$LANGS" = both ] && LANGS="zh en"
: "${OM:?set OM to huashu-motion/cli/om.js}"
: "${FOOTAGE:?set FOOTAGE to the folder with the recorded clips}"
om() { node "$OM" "$@"; }

prep() {
  if [ ! -f "$BUILD/vendor/om.js" ]; then
    rm -rf "$BUILD"
    om new "$BUILD"
    om fonts add "Noto Sans SC" "$BUILD"
    om fonts add "Inter" "$BUILD"
  fi
  cp "$HERE/film/index.html" "$BUILD/index.html"
  python3 "$HERE/webfonts.py" "$HERE/film/index.html" "$BUILD/assets/fonts"
  mkdir -p "$BUILD/tools" "$BUILD/assets/clips" "$BUILD/assets/stills" "$BUILD/assets/sfx"
  cp "$HERE/film/treatment.md" "$BUILD/tools/treatment.md"

  # 实录片段（VP9 WebM：Playwright 的 Chromium 不带 H.264 解码）：统一成 30 fps、无声、1440×900（1.6:1，与卡片同比例）；hop 的录像顶上有一行说明文字，裁掉。只用 #53 之后的实录（小人沿箭头滑行或跳过去）：glide/after.mp4 和 agora-motion.mp4 里还有已删掉的脚手架爬梯，不用。
  clip() { # name src crop
    ffmpeg -v error -y -i "$FOOTAGE/$2" -an -vf "$3,scale=1440:900:flags=lanczos,fps=30,format=yuv420p" \
      -c:v libvpx-vp9 -crf 24 -b:v 0 -deadline good -cpu-used 4 -row-mt 1 -g 15 "$BUILD/assets/clips/$1.webm"
  }
  clip reveal  reveal/after.mp4        "crop=1280:800:0:0"
  clip library reveal/library.mp4      "crop=1280:800:0:0"
  clip wheel   semantic-zoom/wheel.mp4 "crop=1280:800:0:0"
  clip hop     hop/after.mp4           "crop=1488:930:56:90"

  # README 里的截图（docs/media/），蒙太奇用
  for s in trajectory terminal share guest choose-agent; do cp "$REPO/docs/media/$s.png" "$BUILD/assets/stills/"; done
  cp "$REPO/docs/assets/banner.png" "$BUILD/assets/stills/banner.png"
  # README 示意图的上半部分（数据流），只改 viewBox 裁出来
  sed -e '1s/width="1600" height="1130" viewBox="0 0 1600 1130"/width="1520" height="410" viewBox="40 80 1520 410"/' \
    "$REPO/docs/assets/how-it-works.svg" > "$BUILD/assets/stills/flow.svg"
  cp /usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf "$BUILD/assets/fonts/"   # 终端里的等宽字（DejaVu，自由许可）

  # earshot 音效（库里的程序化声音，按画面时刻对准；不需要模型）
  if [ -n "${EARSHOT:-}" ]; then
    es() { "$EARSHOT" sfx render "$@" >/dev/null; }
    es whoosh_fast/crisp -o "$BUILD/assets/sfx/whoosh-in.wav" --dur 0.8 --apex 0.5 --seed 3
    es swipe/glide -o "$BUILD/assets/sfx/swipe.wav" --dur 0.6 --apex 0.3 --seed 2
    es whoosh_big/reverse -o "$BUILD/assets/sfx/suck.wav" --dur 1.0 --apex 0.95 --seed 1
    es logo_sting/soft_bloom -o "$BUILD/assets/sfx/sting.wav"
    for i in 0 1 2; do es pop/$i -o "$BUILD/assets/sfx/pop$i.wav"; done
    es fit/key/thock -o "$BUILD/assets/sfx/key.wav"
    es fit/key.space/thock_space -o "$BUILD/assets/sfx/enter.wav"
  fi
}

render() { # lang
  om set "lang=$1" "$BUILD"
  om sound "$BUILD"        # prep 拷进来的 index.html 不带 <audio id="om-sound">，先重写配乐再渲染
  om check "$BUILD"
  om render "$BUILD"
  om qa "$BUILD"
  finish "$1"
}

# 成片收尾：轻微均衡，两遍 loudnorm 到 -14 LUFS / -1.5 dBTP，最后 1.5 s 声音淡出；再出 ≤ 9.5 MB 的网页版、竖屏和 README 用的 GIF。
finish() { # lang
  local lang="$1" src out="$BUILD/out" json
  src="$(ls -t "$out"/*-v[0-9]*.mp4 | head -1)"
  local full="$out/agora-promo.$lang.mp4"
  local eq="bass=g=-5:f=110,equalizer=f=2500:t=q:w=1:g=3"   # 808 和合成贝斯偏重，低频压一点、2.5 kHz 提一点
  json="$(ffmpeg -hide_banner -nostats -i "$src" -vn -af $eq,loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json -f null - 2>&1 | sed -n '/^{/,/^}/p')"
  get() { printf '%s' "$json" | python3 -c "import json,sys; print(json.load(sys.stdin)['$1'])"; }
  ffmpeg -v error -y -i "$src" -c:v copy -af "$eq,loudnorm=I=-14:TP=-1.5:LRA=11:linear=true:measured_I=$(get input_i):measured_TP=$(get input_tp):measured_LRA=$(get input_lra):measured_thresh=$(get input_thresh):offset=$(get target_offset),afade=t=out:st=38.5:d=1.5" \
    -c:a aac -b:a 256k -ar 48000 -movflags +faststart "$full"
  # 网页版：GitHub 免费账号内嵌视频上限 10 MB。40 s 按 1.65 Mbps 视频 + 128 kbps 音频两遍编码，约 9.0 MB（9.5 MB 以内留余量）
  local pass="$out/x264-$lang"
  ffmpeg -v error -y -i "$full" -c:v libx264 -preset veryslow -tune animation -b:v 1650k -pass 1 -passlogfile "$pass" -an -f null /dev/null
  ffmpeg -v error -y -i "$full" -c:v libx264 -preset veryslow -tune animation -b:v 1650k -maxrate 3500k -bufsize 7000k -pass 2 -passlogfile "$pass" \
    -pix_fmt yuv420p -profile:v high -c:a aac -b:a 128k -ar 48000 -movflags +faststart "$out/agora-promo.$lang.web.mp4"
  rm -f "$pass"*
  # 竖屏 1080×1920：同一条片子居中，背后是它自己放大、虚化、压暗的一层
  ffmpeg -v error -y -i "$full" -filter_complex \
    "[0:v]scale=-2:1920,crop=1080:1920,boxblur=40:2,eq=brightness=-0.08:saturation=0.7[bg];[0:v]scale=1080:-2[fg];[bg][fg]overlay=0:(H-h)/2,format=yuv420p[v]" \
    -map "[v]" -map 0:a -c:v libx264 -preset slow -crf 20 -c:a copy -movflags +faststart "$out/agora-promo-vertical.$lang.mp4"
  # README 动图：逐站画出来（4–10 s）接缩放进子图（16–20 s），无声，960 宽 15 fps，≤ 3.5 MB；
  # demo.zh.gif → docs/assets/demo.gif，demo.en.gif → docs/assets/demo.en.gif
  ffmpeg -v error -y -i "$full" -filter_complex \
    "[0:v]trim=4:10,setpts=PTS-STARTPTS[a];[0:v]trim=16:20,setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1[c];[c]fps=15,scale=960:-1:flags=lanczos,split[x][y];[x]palettegen=max_colors=128:stats_mode=diff[p];[y][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
    "$out/demo.$lang.gif"
  ls -la "$out"
}

case "$STEP" in
  prep) prep ;;
  render) for l in $LANGS; do render "$l"; done ;;
  finish) for l in $LANGS; do finish "$l"; done ;;   # 只重做收尾：取 out/ 里最新的一次渲染，所以一次只给一种语言
  all) prep; for l in $LANGS; do render "$l"; done ;;
esac
