"""生成 README 的「怎么工作」示意图 docs/assets/how-it-works.svg。

运行：python3 docs/assets/how-it-works.py（只用标准库）。PNG 备用图用 docs/promo/render.cjs 截出来。
图里每一格都对着代码核对过：
- 六个会话 agent 都是 T1（server/canvas/adapters/registry.py::session_kinds）。
- 运行中插话：adapter.steer 为 True 的只有 pi / claude / codex；grok、cursor、devin 的 no_steer 写明 -p 不能插话。
- 原生子代理：adapter 有 children() 的是 claude、codex、grok、cursor。
- 服务每 0.4 s 跟随 CLI 的原生会话日志（README「架构」），页面经 HTTP + SSE 连服务。
"""

from __future__ import annotations

import math
from pathlib import Path

W, H = 1600, 1130
PAPER = "#f7f4ee"
DOT = "#d6cfc2"
INK = "#2b2926"
MUTE = "#8b857a"
LINE = "#4a4741"
ACC = "#7048b4"
ACC_SOFT = "#e7ddf6"
MONO = "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace"
SANS = "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans CJK SC', 'Microsoft YaHei', 'WenQuanYi Zen Hei', 'Segoe UI', sans-serif"

C30, S30 = math.cos(math.radians(30)), math.sin(math.radians(30))

out: list[str] = []


def add(s: str) -> None:
    out.append(s)


def iso(ox: float, oy: float, x: float, y: float, z: float = 0.0) -> tuple[float, float]:
    """等轴测投影：x 往右下、y 往左下、z 往上。"""
    return ox + (x - y) * C30, oy + (x + y) * S30 - z


def poly(pts, fill="none", stroke=LINE, sw=1.4, extra="") -> None:
    d = " ".join(f"{x:.1f},{y:.1f}" for x, y in pts)
    add(f'<polygon points="{d}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}" stroke-linejoin="round" {extra}/>')


def line(x1, y1, x2, y2, stroke=LINE, sw=1.4, extra="") -> None:
    add(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="{stroke}" stroke-width="{sw}" stroke-linecap="round" {extra}/>')


def text(x, y, s, size=16, fill=INK, family=SANS, anchor="start", weight=500, extra="") -> None:
    add(f'<text x="{x:.1f}" y="{y:.1f}" font-family="{family}" font-size="{size}" fill="{fill}" text-anchor="{anchor}" font-weight="{weight}" {extra}>{s}</text>')


def box(ox, oy, w, d, h, top="#ffffff", side="#efebe3", front="#e6e1d7", sw=1.4):
    """一块等轴测长方体（w 沿 x，d 沿 y，h 高），返回顶面四角。"""
    p = lambda x, y, z: iso(ox, oy, x, y, z)
    t = [p(0, 0, h), p(w, 0, h), p(w, d, h), p(0, d, h)]
    poly([p(w, 0, 0), p(w, d, 0), p(w, d, h), p(w, 0, h)], fill=side, sw=sw)
    poly([p(0, d, 0), p(w, d, 0), p(w, d, h), p(0, d, h)], fill=front, sw=sw)
    poly(t, fill=top, sw=sw)
    return t


def shadow(ox, oy, w, d, pad=14):
    p = lambda x, y: iso(ox, oy, x, y, 0)
    pts = [p(-pad, -pad), p(w + pad, -pad), p(w + pad, d + pad), p(-pad, d + pad)]
    poly(pts, fill="none", stroke=MUTE, sw=1, extra='stroke-dasharray="3 5" opacity="0.7"')


# ---------- 底板 ----------
add(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" '
    'aria-label="Agora 怎么工作：你的 coding agent 写原生会话日志，本项目的 agora 服务跟随日志并把改动推给浏览器里的画布；下半部分是六个会话 agent 各自能用到的能力。">')
add("<defs>"
    f'<pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.1" fill="{DOT}"/></pattern>'
    f'<filter id="glow" x="-20%" y="-200%" width="140%" height="500%"><feGaussianBlur stdDeviation="5"/></filter>'
    f'<marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M1,1 L9,5 L1,9" fill="none" stroke="{LINE}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></marker>'
    f'<marker id="arrA" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M1,1 L9,5 L1,9" fill="none" stroke="{ACC}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker>'
    "</defs>")
add(f'<rect x="1" y="1" width="{W-2}" height="{H-2}" rx="26" fill="{PAPER}" stroke="#e4ded2" stroke-width="2"/>')
add(f'<rect x="24" y="24" width="{W-48}" height="{H-48}" rx="14" fill="url(#dots)"/>')
for cx, cy in [(64, 64), (W - 64, 64), (64, H - 64), (W - 64, H - 64)]:
    line(cx - 9, cy, cx + 9, cy, stroke=MUTE, sw=1.2)
    line(cx, cy - 9, cx, cy + 9, stroke=MUTE, sw=1.2)
text(92, 70, "FIG 0.1", 17, INK, MONO, weight=500, extra='letter-spacing="2"')
text(W - 92, 70, "ONE AGORA PER PROJECT / AGENT × CANVAS", 17, INK, MONO, "end", 500, 'letter-spacing="2"')


def bracket(x1, x2, y, label, color=INK):
    tw = len(label) * 17 + 30
    mid = (x1 + x2) / 2
    line(x1, y - 8, x1, y + 8, stroke=color, sw=1.4)
    line(x2, y - 8, x2, y + 8, stroke=color, sw=1.4)
    line(x1, y, mid - tw / 2, y, stroke=color, sw=1.4)
    line(mid + tw / 2, y, x2, y, stroke=color, sw=1.4)
    text(mid, y + 7, label, 19, color, SANS, "middle", 600)


# ---------- 上半：数据怎么流 ----------
bracket(170, 1430, 112, "都在你自己的机器上，只监听 127.0.0.1", INK)

# 1. 终端：你的 coding agent（一扇立着的窗口）
ox, oy = 262, 300
shadow(ox, oy, 150, 22)
q = lambda x, z, y=0: iso(ox, oy, x, y, z)
poly([q(150, 0), q(150, 0, 14), q(150, 120, 14), q(150, 120)], fill="#e6e1d7")  # 侧边厚度
poly([q(0, 120), q(150, 120), q(150, 120, 14), q(0, 120, 14)], fill="#efebe3")   # 顶边厚度
poly([q(0, 0), q(150, 0), q(150, 120), q(0, 120)], fill="#fbfaf7")               # 窗面
line(*q(0, 100), *q(150, 100), stroke=LINE, sw=1)
for i in range(3):
    cx, cy = q(10 + i * 9, 110)
    add(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="2.6" fill="none" stroke="{LINE}" stroke-width="1.2"/>')
for k, (u, v) in enumerate([(26, 100), (26, 128), (26, 84)]):
    z = 80 - k * 20
    line(*q(u, z), *q(v, z), stroke=MUTE, sw=1.4)
    gx, gy = q(12, z)
    add(f'<path d="M{gx-3:.1f},{gy-5:.1f} l5,4 l-5,4" stroke="{LINE}" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>')
line(*q(26, 22), *q(36, 22), stroke=ACC, sw=7)  # 光标：唯一的强调色
text(330, 430, "你的 coding agent", 21, INK, SANS, "middle", 700)
text(330, 457, "claude · codex · pi · grok · cursor · devin", 13, MUTE, MONO, "middle")

# 2. 服务：三层机架
ox, oy = 740, 222
shadow(ox, oy, 110, 110)
for k in range(3):
    tt = box(ox, oy - k * 34, 110, 110, 26, top="#fbfaf7")
    a, b = iso(ox, oy - k * 34, 110, 20, 10), iso(ox, oy - k * 34, 110, 60, 10)
    line(*a, *b, stroke=MUTE, sw=1.2)
    for j in range(3):
        sx, sy = iso(ox, oy - k * 34, 110, 78 + j * 8, 13)
        add(f'<circle cx="{sx:.1f}" cy="{sy:.1f}" r="1.8" fill="{MUTE}"/>')
cx, cy = iso(ox, oy - 68, 55, 55, 26)
add(f'<ellipse cx="{cx:.1f}" cy="{cy:.1f}" rx="34" ry="19" fill="none" stroke="{LINE}" stroke-width="1.3"/>')
add(f'<ellipse cx="{cx:.1f}" cy="{cy:.1f}" rx="18" ry="10" fill="none" stroke="{LINE}" stroke-width="1.2"/>')
add(f'<ellipse cx="{cx:.1f}" cy="{cy:.1f}" rx="8" ry="4.5" fill="{ACC}"/>')
text(800, 430, "本项目的 agora 服务", 21, INK, SANS, "middle", 700)
text(800, 457, "&lt;project&gt;/.agora/ · 随代码进 git", 13, MUTE, MONO, "middle")

# 3. 画布：一块平板，上面一张小架构图和一个小人
ox, oy = 1255, 200
shadow(ox, oy, 190, 150)
box(ox, oy, 190, 150, 10, top="#ffffff")
P = lambda x, y: iso(ox, oy, x, y, 10)


def flat_rect(x, y, w, d, stroke=LINE, sw=1.3, fill="none"):
    poly([P(x, y), P(x + w, y), P(x + w, y + d), P(x, y + d)], fill=fill, stroke=stroke, sw=sw)


flat_rect(18, 18, 50, 34)
flat_rect(110, 22, 54, 34, stroke=ACC, sw=2, fill=ACC_SOFT)
flat_rect(64, 96, 56, 34)
add(f'<path d="M{P(68,35)[0]:.1f},{P(68,35)[1]:.1f} L{P(108,39)[0]:.1f},{P(108,39)[1]:.1f}" stroke="{LINE}" stroke-width="1.2" fill="none" marker-end="url(#arr)"/>')
add(f'<path d="M{P(43,52)[0]:.1f},{P(43,52)[1]:.1f} L{P(80,94)[0]:.1f},{P(80,94)[1]:.1f}" stroke="{LINE}" stroke-width="1.2" fill="none" marker-end="url(#arr)"/>')
# 站在紫色节点上的小人（竖直画，不做投影）
fx, fy = P(137, 22)
fy -= 2
add(f'<g stroke="{INK}" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round">'
    f'<path d="M{fx-4},{fy} L{fx-1},{fy-10} L{fx},{fy-17} M{fx+4},{fy} L{fx+2},{fy-10} L{fx},{fy-17} M{fx},{fy-17} L{fx},{fy-29} M{fx},{fy-26} L{fx+6},{fy-21} L{fx+11},{fy-21} M{fx},{fy-26} L{fx-5},{fy-20}"/>'
    f'<circle cx="{fx}" cy="{fy-34}" r="5" fill="#ffffff"/></g>')
add(f'<rect x="{fx+9}" y="{fy-28}" width="10" height="7" rx="1" fill="{ACC}"/>')
text(1300, 430, "浏览器里的画布", 21, INK, SANS, "middle", 700)
text(1300, 457, "excalidraw · 小人 · 子图", 13, MUTE, MONO, "middle")

# 流向箭头
def flow(x1, x2, y, top_label, top_mono, back_label, accent=False):
    col = ACC if accent else LINE
    mk = "arrA" if accent else "arr"
    add(f'<path d="M{x1},{y} L{x2},{y}" stroke="{col}" stroke-width="1.6" stroke-dasharray="7 6" fill="none" marker-end="url(#{mk})"/>')
    add(f'<path d="M{x2},{y+18} L{x1},{y+18}" stroke="{MUTE}" stroke-width="1.2" fill="none" marker-end="url(#arr)"/>')
    text((x1 + x2) / 2, y - 30, top_label, 16, col if accent else INK, SANS, "middle", 600)
    text((x1 + x2) / 2, y - 11, top_mono, 12.5, MUTE, MONO, "middle")
    text((x1 + x2) / 2, y + 42, back_label, 12.5, MUTE, MONO, "middle")


flow(445, 660, 300, "原生会话日志", "JSONL · 每 0.4 s 跟随", "agora canvas apply · 面板发消息", accent=True)
flow(905, 1110, 300, "改动实时推到页面", "HTTP + SSE", "页面执行改图，写回 .agora/")

# ---------- 分隔 ----------
add(f'<line x1="92" y1="510" x2="{W-92}" y2="510" stroke="{DOT}" stroke-width="1.4" stroke-dasharray="2 6"/>')
text(92, 546, "WHAT EACH AGENT GETS", 15, MUTE, MONO, extra='letter-spacing="2"')

# ---------- 下半：agent × 能力 ----------
cols = [("Pi", 640), ("Claude Code", 800), ("Codex", 960), ("Grok", 1120), ("Cursor", 1280), ("Devin", 1440)]
bracket(580, 1500, 584, "会话 agent：你自己安装、自己登录的 CLI", INK)
for name, x in cols:
    text(x, 636, name, 20, INK, SANS, "middle", 700)

lanes = [
    ("实时画布：小人 · 进度指针 · 逐站画图", "follows native session logs", None, True),
    ("面板发消息，终端里接着同一个会话", "same native session id", None, False),
    ("一轮还在跑时插话", "steer a running turn", {"Grok", "Cursor", "Devin"}, False),
    ("原生子代理也画成小人", "native sub-agents", {"Pi", "Devin"}, False),
]
LANE_Y0, LANE_DY = 726, 92
LX0, LX1 = 230, 1520
# 竖线
last_y = LANE_Y0 + LANE_DY * (len(lanes) - 1)
for name, x in cols:
    line(x, 658, x, last_y, stroke=LINE, sw=1.3, extra='stroke-dasharray="1 0"')


def lane_icon(kind, x, y):
    if kind == 0:  # 画布
        pts = [iso(x, y - 16, 0, 0), iso(x, y - 16, 34, 0), iso(x, y - 16, 34, 26), iso(x, y - 16, 0, 26)]
        poly(pts, fill="#ffffff", sw=1.2)
        a = iso(x, y - 16, 6, 6); b = iso(x, y - 16, 18, 6); c = iso(x, y - 16, 18, 14); d = iso(x, y - 16, 6, 14)
        poly([a, b, c, d], fill=ACC_SOFT, stroke=ACC, sw=1.4)
    elif kind == 1:  # 终端
        add(f'<rect x="{x-18}" y="{y-16}" width="40" height="30" rx="4" fill="#ffffff" stroke="{LINE}" stroke-width="1.2"/>')
        add(f'<path d="M{x-10},{y-4} l5,4 l-5,4 M{x-1},{y+5} h9" stroke="{LINE}" stroke-width="1.3" fill="none" stroke-linecap="round"/>')
    elif kind == 2:  # 对话气泡
        add(f'<path d="M{x-18},{y-14} h38 a4,4 0 0 1 4,4 v16 a4,4 0 0 1 -4,4 h-24 l-8,7 v-7 h-6 a4,4 0 0 1 -4,-4 v-16 a4,4 0 0 1 4,-4 z" fill="#ffffff" stroke="{LINE}" stroke-width="1.2"/>')
        line(x - 10, y - 4, x + 14, y - 4, stroke=MUTE, sw=1.2)
        line(x - 10, y + 3, x + 6, y + 3, stroke=MUTE, sw=1.2)
    else:  # 一大一小两个小人
        for (fx, fy, s) in [(x - 8, y + 14, 1.0), (x + 14, y + 14, 0.72)]:
            add(f'<g transform="translate({fx},{fy}) scale({s})" stroke="{LINE}" stroke-width="1.5" fill="none" stroke-linecap="round">'
                '<path d="M-4,0 L0,-12 L4,0 M0,-12 L0,-24 M0,-21 L-5,-14 M0,-21 L5,-14"/><circle cx="0" cy="-29" r="4.5" fill="#ffffff"/></g>')
    return


for i, (label, mono, missing, hot) in enumerate(lanes):
    y = LANE_Y0 + i * LANE_DY
    lane_icon(i, 148, y - 6)
    text(LX0, y - 18, label, 18, INK, SANS, weight=650)
    text(LX0, y + 26, mono, 12.5, MUTE, MONO)
    if hot:
        add(f'<line x1="{LX0}" y1="{y}" x2="{LX1}" y2="{y}" stroke="{ACC}" stroke-width="9" opacity="0.28" filter="url(#glow)"/>')
        add(f'<line x1="{LX0}" y1="{y}" x2="{LX1}" y2="{y}" stroke="{ACC}" stroke-width="5" opacity="0.14"/>')
        add(f'<line x1="{LX0}" y1="{y}" x2="{LX1}" y2="{y}" stroke="{ACC}" stroke-width="2.2" stroke-dasharray="12 9"/>')
    else:
        line(LX0, y, LX1, y, stroke=LINE, sw=1.4, extra='stroke-dasharray="10 9"')
    col = ACC if hot else LINE
    add(f'<circle cx="{LX0}" cy="{y}" r="5" fill="{PAPER}" stroke="{col}" stroke-width="1.6"/>')
    line(LX1, y - 8, LX1, y + 8, stroke=col, sw=1.6)
    for name, x in cols:
        if missing and name in missing:
            add(f'<rect x="{x-8}" y="{y-8}" width="16" height="16" fill="{PAPER}"/>')
            line(x - 6, y - 6, x + 6, y + 6, stroke=MUTE, sw=1.6)
            line(x - 6, y + 6, x + 6, y - 6, stroke=MUTE, sw=1.6)
        else:
            add(f'<circle cx="{x}" cy="{y}" r="9" fill="{PAPER}" stroke="{col}" stroke-width="1.8"/>')
            add(f'<circle cx="{x}" cy="{y}" r="3.4" fill="{col}"/>')

text(92, H - 58, "×  该 CLI 不提供这项（例如 -p 一轮开始后没有输入口）", 13, MUTE, MONO)
text(W - 92, H - 58, "核对自 server/canvas/adapters/ · 2026-10", 13, MUTE, MONO, "end")

add("</svg>")
Path(__file__).with_name("how-it-works.svg").write_text("\n".join(out) + "\n", encoding="utf-8")
print("wrote how-it-works.svg")
