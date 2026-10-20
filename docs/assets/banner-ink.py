"""生成 README 横幅的动画版 banner-ink.svg：python3 docs/assets/banner-ink.py

做法借自 browser-harness 的 banner-ink.svg：整张位图以 base64 嵌进 SVG，用一个白色圆形做遮罩，
SMIL 让半径从 0 长到盖满画面；圆先经过 feTurbulence + feDisplacementMap，边缘像墨迹一样洇开。
GitHub 在 <img> 里也会播放 SVG 自带的 SMIL 动画，不需要脚本。

我们的改法：
- 墨迹从地平线上的落日光（不是画面正中）洇开，7 秒走完，前 0.5 秒空着。
- 揭示完后，天上那张星座架构图的线和小人再亮一下（同一张图经过亮度抠像 + 柔光叠加，
  用 <use> 引用，不再嵌第二份位图），然后停在略亮一点的状态。
- 位图在 PNG 和几档 JPEG 里取最小、且不肉眼可见变差的那一档（默认 JPEG q90）。
"""
import base64
import io
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
SRC = HERE / "banner.png"
OUT = HERE / "banner-ink.svg"
QUALITY = int(sys.argv[1]) if len(sys.argv) > 1 else 90

W, H = 2400, 800
CX, CY = 1140, 540          # 落日光的中心（地平线上最亮处）
R_END = 1500                # 从 (CX, CY) 到最远角约 1262，加上位移 120 和余量
DUR = 7.0                   # 墨迹总时长（秒）
HOLD = 0.5                  # 开头停在 0 的时长
GLOW_AT = 5.2               # 架构图开始亮起
GLOW_DUR = 2.4

im = Image.open(SRC).convert("RGB")
assert im.size == (W, H), im.size
buf = io.BytesIO()
im.save(buf, "JPEG", quality=QUALITY, optimize=True, progressive=True, subsampling=0)
jpg = buf.getvalue()
png = SRC.read_bytes()
data, mime = (jpg, "image/jpeg") if len(jpg) < len(png) else (png, "image/png")
b64 = base64.b64encode(data).decode()

hold = HOLD / DUR
svg = f"""<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 {W} {H}" width="{W}" height="{H}">
  <title>Agora</title>
  <defs>
    <filter id="ink" x="-20%" y="-20%" width="140%" height="140%">
      <feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="3" seed="11" result="noise"/>
      <feDisplacementMap in="SourceGraphic" in2="noise" scale="120" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <mask id="reveal" maskUnits="userSpaceOnUse" x="0" y="0" width="{W}" height="{H}">
      <rect width="{W}" height="{H}" fill="black"/>
      <circle cx="{CX}" cy="{CY}" r="0" fill="white" filter="url(#ink)">
        <animate attributeName="r" values="0;0;{R_END}" keyTimes="0;{hold:.4f};1" dur="{DUR}s" fill="freeze"
                 calcMode="spline" keySplines="0 0 1 1; 0.22 0.61 0.36 1"/>
      </circle>
    </mask>
    <!-- 只留下天上的亮暖色像素（星座图的线、节点框、小人），再柔化一点 -->
    <filter id="lines" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix" values="1.25 0 0 0 0.05  0 1.2 0 0 0.04  0 0 1.1 0 0  4.2 3.6 -4.8 0 -3.15" result="key"/>
      <feGaussianBlur in="key" stdDeviation="2.2" result="soft"/>
      <feMerge><feMergeNode in="soft"/><feMergeNode in="key"/></feMerge>
    </filter>
    <linearGradient id="skyfade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="white"/>
      <stop offset="0.42" stop-color="white"/>
      <stop offset="0.5" stop-color="black"/>
    </linearGradient>
    <mask id="sky" maskUnits="userSpaceOnUse" x="0" y="0" width="{W}" height="{H}">
      <rect width="{W}" height="{H}" fill="url(#skyfade)"/>
    </mask>
  </defs>
  <image id="art" href="data:{mime};base64,{b64}" width="{W}" height="{H}" mask="url(#reveal)" preserveAspectRatio="xMidYMid slice"/>
  <g mask="url(#sky)" style="mix-blend-mode:screen" opacity="0">
    <use href="#art" xlink:href="#art" filter="url(#lines)"/>
    <animate attributeName="opacity" values="0;0;0.85;0.35" keyTimes="0;{GLOW_AT / (GLOW_AT + GLOW_DUR):.4f};{(GLOW_AT + GLOW_DUR * 0.35) / (GLOW_AT + GLOW_DUR):.4f};1"
             dur="{GLOW_AT + GLOW_DUR}s" fill="freeze" calcMode="spline" keySplines="0 0 1 1; 0.3 0 0.2 1; 0.4 0 0.2 1"/>
  </g>
</svg>
"""
OUT.write_text(svg)
print(f"{OUT.name}: {mime}, image {len(data):,} B, svg {OUT.stat().st_size:,} B")
