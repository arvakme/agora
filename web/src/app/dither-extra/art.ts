/**
 * Geometry, motion tracks and the dither field for ./index.tsx.
 * Derived in the construction of Dither Icons (MIT, (c) 2026 Unlocalhosted).
 */

export type DitherExtraTexture = 'dither' | 'solid' | 'outline'

export type DitherExtraName =
  | 'tag'
  | 'pin'
  | 'paperclip'
  | 'pencil'
  | 'eye-off'
  | 'bold'
  | 'italic'
  | 'more'
  | 'info'
  | 'columns'
  | 'calendar'
  | 'archive'
  | 'list'
  | 'heading'
  | 'link'
  | 'image'
  | 'keyboard'

/* ------------------------------------------------------------------ motion */

// Same easing vocabulary as the library's src/motions/authoring.ts.
export const ease = {
  settle: 'cubic-bezier(.22,1,.36,1)',
  smooth: 'cubic-bezier(.4,0,.2,1)',
  accelerate: 'cubic-bezier(.55,0,.85,.45)'
}

export interface Frame {
  at: number
  transform?: string
  opacity?: number
  easing?: string
}
export interface Track {
  part: string
  origin: string
  frames: Frame[]
}
export interface Motion {
  duration: number
  caption: string
  stages: [string, string, string]
  tracks: Track[]
}

const pose = (at: number, transform: string, easing: string = ease.smooth): Frame => ({
  at,
  transform,
  easing
})
const light = (at: number, opacity: number, transform = 'none'): Frame => ({
  at,
  opacity,
  transform
})
const actor = (part: string, origin: string, frames: Frame[]): Track => ({ part, origin, frames })
const motion = (
  duration: number,
  caption: string,
  stages: [string, string, string],
  tracks: Track[]
): Motion => ({ duration, caption, stages, tracks })

/* tag — hangs from its eyelet; swings like the library's bell shell. */
const TAG_T = { rest: 0, lift: 100, swing: 260, back: 430, again: 600, near: 760, settle: 960 }
const tagMotion = motion(
  TAG_T.settle,
  'The tag swings from its eyelet and settles.',
  ['Lift', 'Swing', 'Hang'],
  [
    actor('tag-body', '7.6px 7.6px', [
      pose(TAG_T.rest, 'rotate(0deg)'),
      pose(TAG_T.lift, 'rotate(-6deg)', ease.accelerate),
      pose(TAG_T.swing, 'rotate(11deg)'),
      pose(TAG_T.back, 'rotate(-7deg)'),
      pose(TAG_T.again, 'rotate(3.5deg)'),
      pose(TAG_T.near, 'rotate(-1deg)'),
      pose(TAG_T.settle, 'rotate(0deg)')
    ]),
    actor('tag-sway', '19px 19px', [
      light(TAG_T.rest, 0, 'scale(.8)'),
      light(TAG_T.lift, 0, 'scale(.8)'),
      light(TAG_T.swing, 0.8, 'scale(1)'),
      light(520, 0, 'scale(1.15)'),
      light(TAG_T.settle, 0, 'scale(.8)')
    ])
  ]
)

/* pin — lifts, drives down into the surface, small impact marks. */
const PIN_T = { rest: 0, lift: 150, press: 330, rebound: 470, home: 620, clear: 700, settle: 900 }
const pinMotion = motion(
  PIN_T.settle,
  'The pin lifts, then presses into the surface.',
  ['Lift', 'Press', 'Hold'],
  [
    actor('pin-body', '12px 21.5px', [
      pose(PIN_T.rest, 'translateY(0px) scale(1)'),
      pose(PIN_T.lift, 'translateY(-1.6px) scale(1)', ease.accelerate),
      pose(PIN_T.press, 'translateY(.5px) scale(1.03,.97)', ease.settle),
      pose(PIN_T.rebound, 'translateY(-.2px) scale(1)'),
      pose(PIN_T.home, 'translateY(0px) scale(1)'),
      pose(PIN_T.settle, 'translateY(0px) scale(1)')
    ]),
    actor('pin-impact', '12px 21.6px', [
      light(PIN_T.rest, 0, 'scaleX(.7)'),
      light(PIN_T.press - 20, 0, 'scaleX(.7)'),
      light(PIN_T.press + 40, 0.85, 'scaleX(1)'),
      light(PIN_T.clear, 0, 'scaleX(1.25)'),
      light(PIN_T.settle, 0, 'scaleX(.7)')
    ])
  ]
)

/* paperclip — catches the page, wiggles, grips. */
const CLIP_T = { rest: 0, catch: 130, wiggle: 290, back: 440, grip: 590, home: 760, settle: 900 }
const paperclipMotion = motion(
  CLIP_T.settle,
  'The clip wiggles onto the page and grips.',
  ['Catch', 'Wiggle', 'Grip'],
  [
    actor('clip', '12px 12px', [
      pose(CLIP_T.rest, 'translateY(0px) rotate(0deg)'),
      pose(CLIP_T.catch, 'translateY(-.8px) rotate(-9deg)', ease.accelerate),
      pose(CLIP_T.wiggle, 'translateY(-.3px) rotate(7deg)'),
      pose(CLIP_T.back, 'translateY(.2px) rotate(-4.5deg)'),
      pose(CLIP_T.grip, 'translateY(0px) rotate(2deg)', ease.settle),
      pose(CLIP_T.home, 'translateY(0px) rotate(0deg)'),
      pose(CLIP_T.settle, 'translateY(0px) rotate(0deg)')
    ]),
    actor('clip-hold', '12px 20.8px', [
      light(CLIP_T.rest, 0, 'scale(.7)'),
      light(CLIP_T.back, 0, 'scale(.7)'),
      light(CLIP_T.grip, 0.8, 'scale(1)'),
      light(CLIP_T.home, 0, 'scale(1.2)'),
      light(CLIP_T.settle, 0, 'scale(.7)')
    ])
  ]
)

/* pencil — touches down, writes a short line, lifts. */
const PENCIL_T = { rest: 0, lift: 120, touch: 260, write: 560, hold: 640, home: 900, settle: 1040 }
const pencilMotion = motion(
  PENCIL_T.settle,
  'The pencil touches down and writes a short line.',
  ['Touch', 'Write', 'Lift'],
  [
    actor('pencil-hand', '12px 12px', [
      pose(PENCIL_T.rest, 'translate(0px,0px)'),
      pose(PENCIL_T.lift, 'translate(.5px,-.5px)', ease.accelerate),
      pose(PENCIL_T.touch, 'translate(-.6px,.6px)'),
      pose(PENCIL_T.write, 'translate(2.2px,.4px)'),
      pose(PENCIL_T.hold, 'translate(2.2px,.4px)'),
      pose(PENCIL_T.home, 'translate(0px,0px)'),
      pose(PENCIL_T.settle, 'translate(0px,0px)')
    ]),
    actor('pencil-line', '3.4px 21.4px', [
      light(PENCIL_T.rest, 0, 'scaleX(.1)'),
      light(PENCIL_T.touch, 0, 'scaleX(.1)'),
      { ...light(PENCIL_T.write, 0.85, 'scaleX(1)'), easing: 'linear' },
      light(PENCIL_T.hold, 0.85, 'scaleX(1)'),
      light(PENCIL_T.home, 0, 'scaleX(1)'),
      light(PENCIL_T.settle, 0, 'scaleX(.1)')
    ])
  ]
)

/* eye-off — the lids blink while the slash withdraws and strikes again. */
const EYE_OFF_T = {
  rest: 0,
  widen: 110,
  close: 260,
  hold: 340,
  open: 560,
  strike: 520,
  home: 760,
  clear: 860,
  settle: 1040
}
const EYE_OFF_LIDS: Frame[] = [
  pose(EYE_OFF_T.rest, 'scaleY(1)'),
  pose(EYE_OFF_T.widen, 'scaleY(1.035)', ease.accelerate),
  pose(EYE_OFF_T.close, 'scaleY(.12)'),
  pose(EYE_OFF_T.hold, 'scaleY(.12)', ease.settle),
  pose(EYE_OFF_T.open, 'scaleY(1.04)'),
  pose(EYE_OFF_T.home, 'scaleY(1)'),
  pose(EYE_OFF_T.settle, 'scaleY(1)')
]
const EYE_OFF_SLASH: Frame[] = [
  pose(EYE_OFF_T.rest, 'scaleX(1)'),
  pose(180, 'scaleX(.5)', ease.accelerate),
  pose(EYE_OFF_T.hold, 'scaleX(.5)', ease.settle),
  pose(EYE_OFF_T.strike, 'scaleX(1.04)'),
  pose(EYE_OFF_T.home, 'scaleX(1)'),
  pose(EYE_OFF_T.settle, 'scaleX(1)')
]
const eyeOffMotion = motion(
  EYE_OFF_T.settle,
  'The eye blinks shut as the slash strikes across it again.',
  ['Close', 'Strike', 'Rest'],
  [
    actor('eyeoff-lids', '12px 12px', EYE_OFF_LIDS),
    actor('eyeoff-aperture', '12px 12px', EYE_OFF_LIDS),
    actor('eyeoff-slash', '1.5px 12px', EYE_OFF_SLASH),
    actor('eyeoff-gap', '1.5px 12px', EYE_OFF_SLASH),
    actor('eyeoff-tip', '19.6px 19.6px', [
      light(EYE_OFF_T.rest, 0, 'scale(.7)'),
      light(EYE_OFF_T.strike - 40, 0, 'scale(.7)'),
      light(EYE_OFF_T.strike + 40, 0.8, 'scale(1)'),
      light(EYE_OFF_T.clear, 0, 'scale(1.25)'),
      light(EYE_OFF_T.settle, 0, 'scale(.7)')
    ])
  ]
)

/* bold — the letter gathers, then widens into its weight. */
const BOLD_T = { rest: 0, gather: 130, widen: 320, back: 480, near: 620, settle: 820 }
const boldMotion = motion(
  BOLD_T.settle,
  'The letter gathers, then spreads into its weight.',
  ['Gather', 'Widen', 'Set'],
  [
    actor('bold-glyph', '11px 20.5px', [
      pose(BOLD_T.rest, 'scale(1,1)'),
      pose(BOLD_T.gather, 'scale(.94,.97)', ease.settle),
      pose(BOLD_T.widen, 'scale(1.1,1.02)'),
      pose(BOLD_T.back, 'scale(.98,1)'),
      pose(BOLD_T.near, 'scale(1.02,1)'),
      pose(BOLD_T.settle, 'scale(1,1)')
    ]),
    actor('bold-weight', '12px 12px', [
      light(BOLD_T.rest, 0, 'scaleX(.85)'),
      light(BOLD_T.gather, 0, 'scaleX(.85)'),
      light(BOLD_T.widen, 0.75, 'scaleX(1)'),
      light(560, 0, 'scaleX(1.1)'),
      light(BOLD_T.settle, 0, 'scaleX(.85)')
    ])
  ]
)

/* italic — the stem leans past its slant and returns. */
const ITALIC_T = { rest: 0, rise: 120, lean: 340, back: 500, near: 640, settle: 820 }
const italicMotion = motion(
  ITALIC_T.settle,
  'The stem leans further into its slant, then returns.',
  ['Rise', 'Lean', 'Return'],
  [
    actor('italic-glyph', '12px 20px', [
      pose(ITALIC_T.rest, 'skewX(0deg)'),
      pose(ITALIC_T.rise, 'skewX(6deg)', ease.settle),
      pose(ITALIC_T.lean, 'skewX(-12deg)'),
      pose(ITALIC_T.back, 'skewX(3deg)'),
      pose(ITALIC_T.near, 'skewX(-1deg)'),
      pose(ITALIC_T.settle, 'skewX(0deg)')
    ]),
    actor('italic-trail', '20.5px 4px', [
      light(ITALIC_T.rest, 0, 'translateX(0px)'),
      light(ITALIC_T.rise, 0, 'translateX(0px)'),
      light(ITALIC_T.lean, 0.75, 'translateX(-.6px)'),
      light(560, 0, 'translateX(-1.2px)'),
      light(ITALIC_T.settle, 0, 'translateX(0px)')
    ])
  ]
)

/* more — three dots pass a small wave left to right. */
export const MORE_DOTS = [5, 12, 19]
const MORE_STEP = 90
const moreMotion = motion(
  860,
  'A small wave passes through the three dots.',
  ['Lift', 'Pass', 'Rest'],
  MORE_DOTS.map((x, i) =>
    actor(`more-dot-${i}`, `${x}px 12px`, [
      pose(0, 'translateY(0px)'),
      pose(60 + i * MORE_STEP, 'translateY(0px)', ease.accelerate),
      pose(170 + i * MORE_STEP, 'translateY(-2.2px)'),
      pose(310 + i * MORE_STEP, 'translateY(.3px)', ease.settle),
      pose(430 + i * MORE_STEP, 'translateY(0px)'),
      pose(860, 'translateY(0px)')
    ])
  )
)

/* info — the dot hops and lands on the stem; the ring answers. */
const INFO_T = { rest: 0, rise: 180, land: 360, answer: 380, home: 500, clear: 700, settle: 900 }
const infoMotion = motion(
  INFO_T.settle,
  'The dot hops and lands on the stem; the ring answers.',
  ['Rise', 'Land', 'Attend'],
  [
    actor('info-dot', '12px 7.4px', [
      pose(INFO_T.rest, 'translateY(0px)'),
      pose(INFO_T.rise, 'translateY(-1.8px)', ease.accelerate),
      pose(INFO_T.land, 'translateY(.35px)', ease.settle),
      pose(INFO_T.home, 'translateY(0px)'),
      pose(INFO_T.settle, 'translateY(0px)')
    ]),
    actor('info-stem', '12px 17.2px', [
      pose(INFO_T.rest, 'scaleY(1)'),
      pose(330, 'scaleY(1)', ease.accelerate),
      pose(INFO_T.answer, 'scaleY(.86)', ease.settle),
      pose(INFO_T.home, 'scaleY(1.04)'),
      pose(640, 'scaleY(1)'),
      pose(INFO_T.settle, 'scaleY(1)')
    ]),
    actor('info-ring', '12px 12px', [
      light(INFO_T.rest, 0, 'scale(.96)'),
      light(INFO_T.answer, 0, 'scale(.96)'),
      light(460, 0.5, 'scale(1.02)'),
      light(INFO_T.clear, 0, 'scale(1.08)'),
      light(INFO_T.settle, 0, 'scale(.96)')
    ])
  ]
)

/* columns — the divider tests both panes, then settles in the middle. */
const COL_T = { rest: 0, left: 260, right: 520, near: 680, home: 840, settle: 1000 }
const PANE_W = 6.7
const columnsMotion = motion(
  COL_T.settle,
  'The divider tries each side, then settles between two panes.',
  ['Draw', 'Balance', 'Split'],
  [
    actor('columns-divider', '12px 12px', [
      pose(COL_T.rest, 'translateX(0px)'),
      pose(COL_T.left, 'translateX(-2.6px)'),
      pose(COL_T.right, 'translateX(1.6px)'),
      pose(COL_T.near, 'translateX(-.4px)', ease.settle),
      pose(COL_T.home, 'translateX(0px)'),
      pose(COL_T.settle, 'translateX(0px)')
    ]),
    actor('columns-pane', '4.4px 12px', [
      { at: COL_T.rest, opacity: 0, transform: 'scaleX(1)', easing: ease.smooth },
      {
        at: COL_T.left,
        opacity: 0.3,
        transform: `scaleX(${(PANE_W - 2.6) / PANE_W})`,
        easing: ease.smooth
      },
      {
        at: COL_T.right,
        opacity: 0.14,
        transform: `scaleX(${(PANE_W + 1.6) / PANE_W})`,
        easing: ease.settle
      },
      { at: COL_T.near, opacity: 0.06, transform: `scaleX(${(PANE_W - 0.4) / PANE_W})` },
      { at: COL_T.home, opacity: 0, transform: 'scaleX(1)' },
      { at: COL_T.settle, opacity: 0, transform: 'scaleX(1)' }
    ])
  ]
)

/* calendar — the rings tug, the page turns, today is marked. */
const CAL_T = {
  rest: 0,
  tug: 140,
  release: 300,
  turn: 480,
  near: 620,
  home: 760,
  clear: 820,
  settle: 1000
}
const calendarMotion = motion(
  CAL_T.settle,
  'The rings tug, the page turns, and today is marked.',
  ['Tug', 'Turn', 'Mark'],
  [
    actor('cal-rings', '12px 4.5px', [
      pose(CAL_T.rest, 'translateY(0px)'),
      pose(CAL_T.tug, 'translateY(-.9px)', ease.settle),
      pose(CAL_T.release, 'translateY(0px)'),
      pose(CAL_T.settle, 'translateY(0px)')
    ]),
    actor('cal-date', '15.6px 14.6px', [
      pose(CAL_T.rest, 'scale(1)'),
      pose(CAL_T.tug, 'scale(1)', ease.accelerate),
      pose(CAL_T.release, 'scale(.4)', ease.settle),
      pose(CAL_T.turn, 'scale(1.18)'),
      pose(CAL_T.near, 'scale(.96)'),
      pose(CAL_T.home, 'scale(1)'),
      pose(CAL_T.settle, 'scale(1)')
    ]),
    actor('cal-flash', '15.6px 14.6px', [
      light(CAL_T.rest, 0, 'scale(.7)'),
      light(CAL_T.release, 0, 'scale(.7)'),
      light(CAL_T.turn, 0.8, 'scale(1)'),
      light(CAL_T.clear, 0, 'scale(1.2)'),
      light(CAL_T.settle, 0, 'scale(.7)')
    ])
  ]
)

/* archive — the lid lifts, a sheet drops in, the lid closes. */
const ARC_T = { rest: 0, gather: 150, open: 360, hold: 560, shut: 720, seat: 820, settle: 1100 }
const archiveMotion = motion(
  ARC_T.settle,
  'The lid lifts, a sheet drops in, and the lid closes.',
  ['Open', 'Drop', 'Close'],
  [
    actor('archive-lid', '2.5px 8.5px', [
      pose(ARC_T.rest, 'translateY(0px) rotate(0deg)'),
      pose(ARC_T.gather, 'translateY(-.3px) rotate(0deg)', ease.settle),
      pose(ARC_T.open, 'translateY(-2.2px) rotate(-6deg)'),
      pose(ARC_T.hold, 'translateY(-2.2px) rotate(-6deg)', ease.accelerate),
      pose(ARC_T.shut, 'translateY(.3px) rotate(0deg)', ease.settle),
      pose(ARC_T.seat, 'translateY(0px) rotate(0deg)'),
      pose(ARC_T.settle, 'translateY(0px) rotate(0deg)')
    ]),
    actor('archive-sheet', '12px 8px', [
      light(ARC_T.rest, 0, 'translateY(-2px)'),
      light(ARC_T.open, 0, 'translateY(-2px)'),
      light(400, 0.85, 'translateY(-2px)'),
      { ...light(620, 0.85, 'translateY(2.6px)'), easing: ease.accelerate },
      light(ARC_T.shut, 0, 'translateY(3px)'),
      light(ARC_T.settle, 0, 'translateY(-2px)')
    ]),
    actor('archive-seat', '12px 9px', [
      light(ARC_T.rest, 0, 'scaleX(.95)'),
      light(ARC_T.shut, 0, 'scaleX(.95)'),
      light(ARC_T.seat, 0.7, 'scaleX(1)'),
      light(980, 0, 'scaleX(1.07)'),
      light(ARC_T.settle, 0, 'scaleX(.95)')
    ])
  ]
)

/* list — each row gathers and extends in turn. */
export const LIST_Y = [6.5, 12, 17.5]
export const LIST_END = [20, 20, 17]
const LIST_STEP = 70
const listMotion = motion(
  900,
  'Each row gathers and extends in turn.',
  ['Gather', 'Extend', 'Align'],
  LIST_Y.flatMap((y, i) => [
    actor(`list-line-${i}`, `9px ${y}px`, [
      pose(0, 'scaleX(1)'),
      pose(i * LIST_STEP, 'scaleX(1)', ease.accelerate),
      pose(120 + i * LIST_STEP, 'scaleX(.55)'),
      pose(330 + i * LIST_STEP, 'scaleX(1.05)', ease.settle),
      pose(480 + i * LIST_STEP, 'scaleX(1)'),
      pose(900, 'scaleX(1)')
    ]),
    actor(`list-dot-${i}`, `4.8px ${y}px`, [
      pose(0, 'scale(1)'),
      pose(200 + i * LIST_STEP, 'scale(1)', ease.settle),
      pose(330 + i * LIST_STEP, 'scale(1.35)'),
      pose(500 + i * LIST_STEP, 'scale(1)'),
      pose(900, 'scale(1)')
    ])
  ])
)

/* heading — the letter gathers and rises to title rank. */
const HEAD_T = { rest: 0, gather: 130, rise: 330, back: 480, home: 640, clear: 650, settle: 860 }
const headingMotion = motion(
  HEAD_T.settle,
  'The letter gathers and rises; a rule marks its rank.',
  ['Gather', 'Rise', 'Rank'],
  [
    actor('heading-glyph', '12px 20.2px', [
      pose(HEAD_T.rest, 'scaleY(1)'),
      pose(HEAD_T.gather, 'scaleY(.9)', ease.settle),
      pose(HEAD_T.rise, 'scaleY(1.08)'),
      pose(HEAD_T.back, 'scaleY(.98)'),
      pose(HEAD_T.home, 'scaleY(1)'),
      pose(HEAD_T.settle, 'scaleY(1)')
    ]),
    actor('heading-rank', '12px 22.3px', [
      light(HEAD_T.rest, 0, 'scaleX(.3)'),
      light(HEAD_T.gather, 0, 'scaleX(.3)'),
      light(HEAD_T.rise, 0.8, 'scaleX(1)'),
      light(HEAD_T.clear, 0, 'scaleX(1)'),
      light(HEAD_T.settle, 0, 'scaleX(.3)')
    ])
  ]
)

/* link — the halves part, then join over the bar. */
const LINK_T = { rest: 0, part: 180, join: 400, home: 560, clear: 640, settle: 860 }
const linkHalf = (dir: 1 | -1): Frame[] => [
  pose(LINK_T.rest, 'translateX(0px)'),
  pose(LINK_T.part, `translateX(${dir * 1.3}px)`, ease.accelerate),
  pose(LINK_T.join, `translateX(${dir * -0.45}px)`, ease.settle),
  pose(LINK_T.home, 'translateX(0px)'),
  pose(LINK_T.settle, 'translateX(0px)')
]
const linkMotion = motion(
  LINK_T.settle,
  'The two halves part, then join over the bar.',
  ['Part', 'Join', 'Hold'],
  [
    actor('link-left', '12px 12px', linkHalf(-1)),
    actor('link-right', '12px 12px', linkHalf(1)),
    actor('link-bar', '12px 12px', [
      pose(LINK_T.rest, 'scaleX(1)'),
      pose(LINK_T.part, 'scaleX(.7)', ease.accelerate),
      pose(LINK_T.join, 'scaleX(1.12)', ease.settle),
      pose(LINK_T.home, 'scaleX(1)'),
      pose(LINK_T.settle, 'scaleX(1)')
    ]),
    actor('link-spark', '12px 12px', [
      light(LINK_T.rest, 0, 'scale(.7)'),
      light(LINK_T.join - 40, 0, 'scale(.7)'),
      light(LINK_T.join + 30, 0.8, 'scale(1)'),
      light(LINK_T.clear, 0, 'scale(1.25)'),
      light(LINK_T.settle, 0, 'scale(.7)')
    ])
  ]
)

/* image — the sun dips and rises over the hills. */
const IMG_T = { rest: 0, set: 160, rise: 440, near: 600, home: 760, settle: 1000 }
const imageMotion = motion(
  IMG_T.settle,
  'The sun dips, then rises over the hills.',
  ['Set', 'Rise', 'Glow'],
  [
    actor('image-sun', '16px 9.4px', [
      pose(IMG_T.rest, 'translateY(0px)'),
      pose(IMG_T.set, 'translateY(1.4px)', ease.settle),
      pose(IMG_T.rise, 'translateY(-1px)'),
      pose(IMG_T.near, 'translateY(.2px)'),
      pose(IMG_T.home, 'translateY(0px)'),
      pose(IMG_T.settle, 'translateY(0px)')
    ]),
    actor('image-hills', '12px 18.7px', [
      pose(IMG_T.rest, 'scaleY(1)'),
      pose(IMG_T.set, 'scaleY(.92)', ease.settle),
      pose(IMG_T.rise, 'scaleY(1.05)'),
      pose(640, 'scaleY(1)'),
      pose(IMG_T.settle, 'scaleY(1)')
    ]),
    actor('image-glow', '16px 9.4px', [
      light(IMG_T.rest, 0, 'scale(.8)'),
      light(IMG_T.set, 0, 'scale(.8)'),
      light(IMG_T.rise, 0.6, 'scale(1)'),
      light(IMG_T.home, 0, 'scale(1.15)'),
      light(IMG_T.settle, 0, 'scale(.8)')
    ])
  ]
)

/* keyboard — keys tap across the top row, then the space bar lands. */
const KB_T = { rest: 0, space: 560, lift: 700, clear: 780, settle: 960 }
const KB_STEP = 90
const kbPress = (start: number, depth: number): Frame[] => [
  pose(KB_T.rest, 'translateY(0px) scale(1)'),
  pose(start, 'translateY(0px) scale(1)', ease.accelerate),
  pose(start + 90, `translateY(${depth}px) scale(.86)`, ease.settle),
  pose(start + 220, 'translateY(0px) scale(1)'),
  pose(KB_T.settle, 'translateY(0px) scale(1)')
]
export const KB_KEYS: [number, number][] = [
  [6.8, 10],
  [10.2, 10],
  [13.8, 10],
  [17.2, 10],
  [6.8, 13.8],
  [17.2, 13.8]
]
const keyboardMotion = motion(
  KB_T.settle,
  'Keys tap across the top row; the space bar lands last.',
  ['Tap', 'Space', 'Rest'],
  [
    ...KB_KEYS.slice(0, 4).map(([x, y], i) =>
      actor(`kb-key-${i}`, `${x}px ${y}px`, kbPress(60 + i * KB_STEP, 0.5))
    ),
    actor('kb-space', '12px 13.8px', kbPress(KB_T.space - 90, 0.45)),
    actor('kb-tap', '12px 20.4px', [
      light(KB_T.rest, 0, 'scaleX(.4)'),
      light(KB_T.space - 40, 0, 'scaleX(.4)'),
      light(KB_T.space + 40, 0.8, 'scaleX(1)'),
      light(KB_T.clear, 0, 'scaleX(1.15)'),
      light(KB_T.settle, 0, 'scaleX(.4)')
    ])
  ]
)

export const extraMotions: Record<DitherExtraName, Motion> = {
  tag: tagMotion,
  pin: pinMotion,
  paperclip: paperclipMotion,
  pencil: pencilMotion,
  'eye-off': eyeOffMotion,
  bold: boldMotion,
  italic: italicMotion,
  more: moreMotion,
  info: infoMotion,
  columns: columnsMotion,
  calendar: calendarMotion,
  archive: archiveMotion,
  list: listMotion,
  heading: headingMotion,
  link: linkMotion,
  image: imageMotion,
  keyboard: keyboardMotion
}

/* ---------------------------------------------------------------- geometry */

type Pt = [number, number]

/** Closed polygon with rounded corners (quadratic joins), as a path string. */
function roundPoly(points: Pt[], r: number): string {
  const n = points.length
  let d = ''
  for (let i = 0; i < n; i++) {
    const [px, py] = points[i]
    const [ax, ay] = points[(i + n - 1) % n]
    const [bx, by] = points[(i + 1) % n]
    const la = Math.hypot(px - ax, py - ay)
    const lb = Math.hypot(bx - px, by - py)
    const ra = Math.min(r, la / 2)
    const rb = Math.min(r, lb / 2)
    const s: Pt = [px - ((px - ax) / la) * ra, py - ((py - ay) / la) * ra]
    const e: Pt = [px + ((bx - px) / lb) * rb, py + ((by - py) / lb) * rb]
    const f = (v: number): string => v.toFixed(3).replace(/\.?0+$/, '')
    d += `${i ? 'L' : 'M'}${f(s[0])} ${f(s[1])}Q${f(px)} ${f(py)} ${f(e[0])} ${f(e[1])}`
  }
  return d + 'Z'
}
export const circle = (cx: number, cy: number, r: number): string =>
  `M${cx} ${cy - r}a${r} ${r} 0 1 0 0 ${2 * r}a${r} ${r} 0 1 0 0-${2 * r}Z`
const rrect = (x: number, y: number, w: number, h: number, r: number): string =>
  `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1-${r} ${r}h-${w - 2 * r}a${r} ${r} 0 0 1-${r}-${r}v-${h - 2 * r}a${r} ${r} 0 0 1 ${r}-${r}Z`

export const TAG_ART = {
  body: roundPoly(
    [
      [3, 3],
      [11.2, 3],
      [21, 12.8],
      [12.8, 21],
      [3, 11.2]
    ],
    1.6
  ),
  hole: circle(7.6, 7.6, 1.6),
  line: roundPoly(
    [
      [3.8, 3.8],
      [10.9, 3.8],
      [20, 12.9],
      [12.9, 20],
      [3.8, 10.9]
    ],
    1.3
  ),
  holeLine: circle(7.6, 7.6, 1.35),
  sway: 'M20.4 17.6l1.1 1.1M17.6 20.4l1.1 1.1'
}

export const PIN_ART = {
  body: 'M8.7 2.5h6.6a1.35 1.35 0 0 1 0 2.7h-.6l.7 5.4 2.8 2.8v1.4H5.8v-1.4l2.8-2.8.7-5.4h-.6a1.35 1.35 0 0 1 0-2.7Z',
  needle: 'M11.25 14.8h1.5v5.9a.75.75 0 0 1-1.5 0Z',
  line: 'M9 3.2h6a.65.65 0 0 1 0 1.3h-.9l.75 6.3 2.65 2.65v.35H6.5v-.35l2.65-2.65.75-6.3H9a.65.65 0 0 1 0-1.3Z',
  needleLine: 'M12 14.8v6',
  impact: 'M9.4 21.8l-1.2.6M14.6 21.8l1.2.6'
}

export const CLIP_ART = {
  wire: 'M10.8 8.6V15.8a1.6 1.6 0 0 0 3.2 0V6.2a3.2 3.2 0 0 0-6.4 0v10.2a4.4 4.4 0 0 0 8.8 0V9.4',
  hold: 'M10.4 21.9h-.9M13.6 21.9h.9'
}

// Pencil is authored lying along x (tip at left), then turned -45°.
export const PENCIL_ART = {
  body: 'M1.8 12 6.6 9.6H18.2V14.4H6.6Z',
  eraser: 'M19.1 9.6h1.9a1.2 1.2 0 0 1 1.2 1.2v2.4a1.2 1.2 0 0 1-1.2 1.2h-1.9Z',
  bodyLine: 'M2.6 12 6.8 10.3H17.6V13.7H6.8Z',
  eraserLine: 'M19.3 10.3h1.5a.7.7 0 0 1 .7.7v2a.7.7 0 0 1-.7.7h-1.5Z',
  collar: 'M6.8 10.3v3.4',
  line: 'M3.4 21.4c1-.6 2-.6 3 0s2 .6 3 0'
}

// Eye geometry is the library's own EYE_ART (MIT), so eye and eye-off pair.
export const EYE_ART = {
  outline: 'M2 12C4.6 7.8 8.2 5.2 12 5.2S19.4 7.8 22 12C19.4 16.2 15.8 18.8 12 18.8S4.6 16.2 2 12Z',
  aperture:
    'M4.15 12C6.4 8.8 9.15 7 12 7S17.6 8.8 19.85 12C17.6 15.2 14.85 17 12 17S6.4 15.2 4.15 12Z',
  centerline:
    'M2.9 12C5.4 8.25 8.7 6.1 12 6.1S18.6 8.25 21.1 12C18.6 15.75 15.3 17.9 12 17.9S5.4 15.75 2.9 12Z',
  iris: 'M12 8.8a3.2 3.2 0 1 0 0 6.4a3.2 3.2 0 1 0 0-6.4Z',
  catchlight: 'M11 10.3a.6.6 0 1 0 0 1.2a.6.6 0 1 0 0-1.2Z',
  slash: 'M1.5 12H22.5',
  tip: 'M20.5 19.4l.8.2M19.4 20.5l.2.8'
}

export const BOLD_ART = {
  body:
    'M6.2 3.5h6.6a4.3 4.3 0 0 1 3.3 7.06 4.6 4.6 0 0 1-2.8 9.94H6.2a.9.9 0 0 1-.9-.9V4.4a.9.9 0 0 1 .9-.9Z' +
    'M8.4 6.3v4.1h4.2a2.05 2.05 0 0 0 0-4.1Z' +
    'M8.4 13.1v4.6h4.8a2.3 2.3 0 0 0 0-4.6Z',
  line: 'M7 4.3h5.6a3.35 3.35 0 0 1 0 6.7H7ZM7 11h6.3a3.75 3.75 0 0 1 0 7.5H7Z',
  weight: 'M3 10v4M20.9 10v4'
}

export const ITALIC_ART = {
  glyph: 'M10 4h8M6 20h8M15 4 9 20',
  trail: 'M20.4 2.6h1.2'
}

export const INFO_ART = {
  ring: circle(12, 12, 10) + circle(12, 12, 8.2),
  ringLine: circle(12, 12, 9.2),
  stem: rrect(10.95, 10.4, 2.1, 6.8, 1.05),
  stemLine: 'M12 11.2v5.4',
  dot: circle(12, 7.4, 1.3),
  echo: circle(12, 12, 10.9)
}

export const KEYBOARD_ART = {
  body: rrect(2, 5.5, 20, 13, 2.6) + rrect(3.8, 7.3, 16.4, 9.4, 1.2),
  bodyLine: rrect(2.75, 6.25, 18.5, 11.5, 2.2),
  keys: KB_KEYS.map(([x, y]) => rrect(x - 0.9, y - 0.9, 1.8, 1.8, 0.4)),
  space: rrect(9.2, 13, 5.6, 1.6, 0.8),
  spaceLine: 'M10 13.8H14',
  tap: 'M8 20.4H16'
}

export const COLUMNS_ART = {
  frame: rrect(2.5, 3.5, 19, 17, 3.2) + rrect(4.4, 5.4, 15.2, 13.2, 1.6),
  frameLine: rrect(3.2, 4.2, 17.6, 15.6, 2.6),
  divider: 'M11.1 5.4h1.8v13.2h-1.8Z',
  dividerLine: 'M12 4.6V19.4',
  pane: 'M4.4 5.4h6.7v13.2H4.4Z'
}

export const CAL_ART = {
  body: rrect(3, 4.5, 18, 16.5, 2.5) + 'M5 10v8.2a.8.8 0 0 0 .8.8h12.4a.8.8 0 0 0 .8-.8V10Z',
  bodyLine: rrect(3.75, 5.25, 16.5, 15, 2),
  header: 'M3.75 10H20.25',
  rings: rrect(7.2, 2, 1.8, 5, 0.9) + rrect(15, 2, 1.8, 5, 0.9),
  ringLines: 'M8.1 2.7V6.3M15.9 2.7V6.3',
  ringGaps: rrect(6.4, 0.5, 3.4, 7.3, 1.7) + rrect(14.2, 0.5, 3.4, 7.3, 1.7),
  date: rrect(14.2, 13.2, 2.8, 2.8, 0.5),
  flash: 'M18.7 12.4l.7-.7M19 14.6h.9'
}

export const ARCHIVE_ART = {
  lid: rrect(2.5, 3.5, 19, 5, 1.2),
  lidLine: rrect(3.2, 4.2, 17.6, 3.6, 0.9),
  box:
    'M4 9.6h16v9.4a1.8 1.8 0 0 1-1.8 1.8H5.8A1.8 1.8 0 0 1 4 19v-9.4Z' +
    rrect(9.8, 12.2, 4.4, 2, 1),
  boxLine: 'M4.7 8.6V18.6a1.5 1.5 0 0 0 1.5 1.5h11.6a1.5 1.5 0 0 0 1.5-1.5V8.6',
  handleLine: 'M10 13.2h4',
  sheet: rrect(8.5, 5, 7, 4, 0.6),
  seat: 'M2 9.4l-.8.4M22 9.4l.8.4'
}

export const HEADING_ART = {
  glyph: roundPoly(
    [
      [4.3, 3.8],
      [6.7, 3.8],
      [6.7, 10.8],
      [17.3, 10.8],
      [17.3, 3.8],
      [19.7, 3.8],
      [19.7, 20.2],
      [17.3, 20.2],
      [17.3, 13.2],
      [6.7, 13.2],
      [6.7, 20.2],
      [4.3, 20.2]
    ],
    0.45
  ),
  line: 'M5.5 4.6v14.8M18.5 4.6v14.8M5.5 12h13',
  rank: 'M8 22.3h8'
}

export const LINK_ART = {
  left: 'M10 7.5H7.5a4.5 4.5 0 0 0 0 9H10',
  right: 'M14 7.5h2.5a4.5 4.5 0 0 1 0 9H14',
  bar: 'M8.5 12h7',
  spark: 'M12 9.1v-.9M12 14.9v.9'
}

export const IMAGE_ART = {
  frame: rrect(2.5, 3.5, 19, 17, 3) + rrect(4.3, 5.3, 15.4, 13.4, 1.4),
  frameLine: rrect(3.2, 4.2, 17.6, 15.6, 2.4),
  inner: rrect(4.3, 5.3, 15.4, 13.4, 1.4),
  hills: 'M4.3 17.4 9.2 12.2l4 4 2.6-2.5 3.9 3.9V18.7H4.3Z',
  hillsLine: 'M3.9 17.3 9.2 11.9l4 4 2.6-2.5 4.3 4.1',
  sun: circle(16, 9.4, 1.8),
  sunLine: circle(16, 9.4, 1.45),
  glow: circle(16, 9.4, 3)
}

/* ------------------------------------------------------------- rendering */

// The library's ordered-dither field: 96×96 cells of 0.25 units, 8×8 Bayer
// threshold against a tone that rises toward the lower right.
const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28,
  52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7,
  39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21
]
let ditherFieldCache = ''
export function ditherField(): string {
  if (ditherFieldCache) return ditherFieldCache
  let d = ''
  for (let i = 0; i < 96 * 96; i++) {
    const x = i % 96
    const y = Math.floor(i / 96)
    const tone = 0.12 + 0.8 * ((0.35 * x) / 95 + (0.65 * y) / 95)
    if ((BAYER[(y % 8) * 8 + (x % 8)] + 0.5) / 64 < tone) d += `M${x / 4} ${y / 4}h.25v.25h-.25z`
  }
  ditherFieldCache = d
  return d
}

export const extraDefinitions = (Object.keys(extraMotions) as DitherExtraName[]).map((name) => ({
  name,
  caption: extraMotions[name].caption,
  stages: extraMotions[name].stages,
  duration: extraMotions[name].duration
}))
