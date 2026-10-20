"""把官网用的短循环片段编码进 docs/media/clips/：python3 site/scripts/encode-clips.py [录屏目录]

官网不放 GIF（一张 3 MB 起）：录屏片段和「运行中」面板都转成无声 H.264 mp4（faststart，CRF 30，
-tune animation 适合界面录屏），再各截一帧 jpg 当海报和模糊占位的来源。每个几百 KB。

- reveal / zoom / pointer 的源是功能分支验收时录的屏（feat/live-reveal、feat/semantic-zoom、feat/hop），
  默认在 /mnt/project-files/agora-motion-video/；pointer 裁掉顶上那行分支说明。
- live-panel(.en) 的源是仓库里的 docs/assets/live-panel(.en).webp（动图 webp，ffmpeg 读不了，先用 Pillow 拆帧）。

需要 ffmpeg 和 Pillow。换片段只要改 CLIPS，重跑即可；英文界面的录屏写成 <名字>.en.mp4，英文页自动优先用它。
"""
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "docs/media/clips"
SRC = Path(sys.argv[1] if len(sys.argv) > 1 else "/mnt/project-files/agora-motion-video")
X264 = ["-an", "-c:v", "libx264", "-preset", "slow", "-crf", "30", "-tune", "animation", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]

# 名字: (源文件, 额外的滤镜, 海报取第几秒)
CLIPS = {
    "reveal": (SRC / "reveal/after.mp4", "", 9),
    "zoom": (SRC / "semantic-zoom/wheel.mp4", "", 4),
    "pointer": (SRC / "hop/after.mp4", "crop=1520:950:40:70,", 6),
}


def ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True)


def poster(name: str, at: float) -> None:
    ffmpeg("-ss", str(at), "-i", str(OUT / f"{name}.mp4"), "-frames:v", "1", "-q:v", "4", str(OUT / f"{name}.jpg"))


def webp_to_mp4(src: Path, name: str) -> None:
    im = Image.open(src)
    with tempfile.TemporaryDirectory() as tmp:
        durations = []
        for i in range(im.n_frames):
            im.seek(i)
            im.convert("RGB").save(f"{tmp}/{i:05d}.png")
            durations.append(im.info.get("duration", 83))
        fps = round(1000 / (sum(durations) / len(durations)))
        ffmpeg("-framerate", str(fps), "-i", f"{tmp}/%05d.png", *X264, str(OUT / f"{name}.mp4"))
    poster(name, 20)


OUT.mkdir(parents=True, exist_ok=True)
for name, (src, vf, at) in CLIPS.items():
    if not src.exists():
        print(f"跳过 {name}：没有 {src}")
        continue
    ffmpeg("-i", str(src), "-vf", f"{vf}fps=30,scale=1280:-2", *X264, str(OUT / f"{name}.mp4"))
    poster(name, at)
for suffix in ("", ".en"):
    webp_to_mp4(ROOT / f"docs/assets/live-panel{suffix}.webp", f"live-panel{suffix}")
for f in sorted(OUT.iterdir()):
    print(f"{f.stat().st_size // 1024:>6} KB  {f.relative_to(ROOT)}")
