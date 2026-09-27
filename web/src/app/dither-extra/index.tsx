/**
 * Extra icons in the construction of Dither Icons (@unlocalhosted/dither-icons,
 * MIT, Copyright (c) 2026 Unlocalhosted). See ./README.md and ./LICENSE-dither-icons.txt.
 *
 * The library has no tag, pin, paperclip, pencil, eye-off, bold, italic, more,
 * info, columns, calendar, archive, list, heading, link, image or keyboard. These follow
 * its rules so they can sit next to its icons:
 *   - 24×24 viewBox, fill/stroke = currentColor.
 *   - `dither`: the shape at 16% opacity, plus the same shape through a mask of
 *     the library's ordered-dither field (8×8 Bayer, 0.25-unit dots, tone rising
 *     toward the lower right). `solid`: filled. `outline`: centre-line strokes
 *     (1.3–1.9, like the library's crafted icons) or the 1.4 contour.
 *   - Motion: one-shot, authored per icon as timed actor tracks (pose/light
 *     frames, 3 named stages, ~0.8–1.1 s) on `data-part` groups, using the
 *     library's three easings. Accents are thin parts at opacity 0 at rest.
 *   - Playback: Web Animations on hover, focus-visible and click of the icon or
 *     its closest `.di-trigger`; runs to the end; `active` plays on becoming
 *     true; `replayKey` replays; reduced motion, `animate={false}` and unmount
 *     cancel. A CSS fallback plays on hover when the runtime is absent.
 *
 * Wired into the app through ../icons.tsx (the icon facade).
 */
import { forwardRef, useEffect, useId, useImperativeHandle, useRef } from 'react'
import type { ReactNode, SVGProps } from 'react'
import {
  ARCHIVE_ART,
  BOLD_ART,
  CAL_ART,
  CLIP_ART,
  COLUMNS_ART,
  EYE_ART,
  HEADING_ART,
  IMAGE_ART,
  INFO_ART,
  ITALIC_ART,
  KB_KEYS,
  KEYBOARD_ART,
  LINK_ART,
  LIST_END,
  LIST_Y,
  MORE_DOTS,
  PENCIL_ART,
  PIN_ART,
  TAG_ART,
  circle,
  ditherField,
  extraMotions,
  type DitherExtraName,
  type DitherExtraTexture,
  type Motion,
  type Track
} from './art'

export type { DitherExtraName, DitherExtraTexture } from './art'

export interface DitherExtraProps extends Omit<SVGProps<SVGSVGElement>, 'ref' | 'name'> {
  size?: number | string
  texture?: DitherExtraTexture
  animate?: boolean
  active?: boolean
  replayKey?: number
  speed?: number
  progress?: number
  title?: string
}

interface Kit {
  id: string
  texture: DitherExtraTexture
  /** Filled shape: dithered, solid, or its 1.4 contour in outline. */
  draw: (d: string) => ReactNode
  /** Filled shape in dither/solid; a separate centre line in outline. */
  shape: (fill: string, line: string, outlineWidth?: number) => ReactNode
  /** Centre-line stroke at `width` (dither/solid) or `outlineWidth` (outline). */
  line: (d: string, width: number, outlineWidth: number) => ReactNode
  /** Thin response mark, invisible at rest. */
  accent: (part: string, d: string, width?: number) => ReactNode
}

function makeKit(id: string, texture: DitherExtraTexture): Kit {
  const grain = `url(#${id}-grain)`
  const draw = (d: string): ReactNode =>
    texture === 'dither' ? (
      <g>
        <path d={d} fillRule="evenodd" opacity=".16" />
        <path d={d} fillRule="evenodd" mask={grain} />
      </g>
    ) : (
      <path
        d={d}
        fillRule="evenodd"
        fill={texture === 'outline' ? 'none' : 'currentColor'}
        stroke={texture === 'outline' ? 'currentColor' : 'none'}
        strokeWidth={1.4}
        strokeLinejoin="round"
      />
    )
  const stroked = (d: string, width: number, extra?: Record<string, string>): ReactNode => (
    <path
      d={d}
      fill="none"
      stroke="currentColor"
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...extra}
    />
  )
  const line = (d: string, width: number, outlineWidth: number): ReactNode =>
    texture === 'dither' ? (
      <g>
        {stroked(d, width, { opacity: '.16' })}
        {stroked(d, width, { mask: grain })}
      </g>
    ) : (
      stroked(d, texture === 'outline' ? outlineWidth : width)
    )
  const shape = (fill: string, centre: string, outlineWidth = 1.45): ReactNode =>
    texture === 'outline' ? stroked(centre, outlineWidth) : draw(fill)
  const accent = (part: string, d: string, width = 0.6): ReactNode => (
    <g data-part={part} opacity="0">
      {stroked(d, width)}
    </g>
  )
  return { id, texture, draw, shape, line, accent }
}

const MASK_BOX = { maskUnits: 'userSpaceOnUse' as const, x: -24, y: -24, width: 72, height: 72 }

function Artwork({ name, kit }: { name: DitherExtraName; kit: Kit }): ReactNode {
  const { id, texture, draw, shape, line, accent } = kit
  const outline = texture === 'outline'
  switch (name) {
    case 'tag':
      return (
        <>
          <g data-part="tag-body">
            {outline ? (
              <>
                {line(TAG_ART.line, 1.45, 1.45)}
                {line(TAG_ART.holeLine, 1.2, 1.2)}
              </>
            ) : (
              draw(TAG_ART.body + TAG_ART.hole)
            )}
          </g>
          {accent('tag-sway', TAG_ART.sway, 0.65)}
        </>
      )
    case 'pin':
      return (
        <>
          <g data-part="pin-body">
            {shape(PIN_ART.body, PIN_ART.line, 1.4)}
            {outline ? line(PIN_ART.needleLine, 1.5, 1.5) : draw(PIN_ART.needle)}
          </g>
          {accent('pin-impact', PIN_ART.impact, 0.65)}
        </>
      )
    case 'paperclip':
      return (
        <>
          <g transform="rotate(40 12 12)">
            <g data-part="clip">{line(CLIP_ART.wire, 2, 1.55)}</g>
          </g>
          {accent('clip-hold', CLIP_ART.hold, 0.6)}
        </>
      )
    case 'pencil':
      return (
        <>
          <g data-part="pencil-hand">
            <g transform="rotate(-45 12 12)">
              {outline ? (
                <>
                  {line(PENCIL_ART.bodyLine, 1.4, 1.4)}
                  {line(PENCIL_ART.eraserLine, 1.4, 1.4)}
                  {line(PENCIL_ART.collar, 1.1, 1.1)}
                </>
              ) : (
                <>
                  {draw(PENCIL_ART.body)}
                  {draw(PENCIL_ART.eraser)}
                </>
              )}
            </g>
          </g>
          {accent('pencil-line', PENCIL_ART.line, 0.7)}
        </>
      )
    case 'eye-off': {
      const gapWidth = outline ? 3.8 : 4.4
      return (
        <>
          <defs>
            <mask id={`${id}-slash`} {...MASK_BOX}>
              <rect x="-24" y="-24" width="72" height="72" fill="white" />
              <g transform="rotate(45 12 12)">
                <g data-part="eyeoff-gap">
                  <path
                    d={EYE_ART.slash}
                    stroke="black"
                    strokeWidth={gapWidth}
                    strokeLinecap="round"
                  />
                </g>
              </g>
            </mask>
            <clipPath id={`${id}-aperture`}>
              <path data-part="eyeoff-aperture" d={EYE_ART.aperture} />
            </clipPath>
          </defs>
          <g mask={`url(#${id}-slash)`}>
            <g data-part="eyeoff-lids">
              {outline
                ? line(EYE_ART.centerline, 1.65, 1.65)
                : draw(EYE_ART.outline + EYE_ART.aperture)}
            </g>
            <g clipPath={`url(#${id}-aperture)`}>
              {outline ? (
                <>
                  <circle
                    cx="12"
                    cy="12"
                    r="2.7"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                  />
                  <circle cx="12" cy="12" r=".9" />
                </>
              ) : (
                draw(EYE_ART.iris + EYE_ART.catchlight)
              )}
            </g>
          </g>
          <g transform="rotate(45 12 12)">
            <g data-part="eyeoff-slash">{line(EYE_ART.slash, 2, 1.65)}</g>
          </g>
          {accent('eyeoff-tip', EYE_ART.tip, 0.6)}
        </>
      )
    }
    case 'bold':
      return (
        <>
          <g data-part="bold-glyph">{shape(BOLD_ART.body, BOLD_ART.line, 1.9)}</g>
          {accent('bold-weight', BOLD_ART.weight, 0.65)}
        </>
      )
    case 'italic':
      return (
        <>
          <g data-part="italic-glyph">{line(ITALIC_ART.glyph, 2.2, 1.7)}</g>
          {accent('italic-trail', ITALIC_ART.trail, 0.65)}
        </>
      )
    case 'more':
      return (
        <>
          {MORE_DOTS.map((x, i) => (
            <g key={x} data-part={`more-dot-${i}`}>
              {outline ? <path d={circle(x, 12, 1.5)} /> : draw(circle(x, 12, 1.9))}
            </g>
          ))}
        </>
      )
    case 'info':
      return (
        <>
          {outline ? line(INFO_ART.ringLine, 1.5, 1.5) : draw(INFO_ART.ring)}
          <g data-part="info-stem">
            {outline ? line(INFO_ART.stemLine, 1.8, 1.8) : draw(INFO_ART.stem)}
          </g>
          <g data-part="info-dot">
            {outline ? <path d={circle(12, 7.5, 1.15)} /> : draw(INFO_ART.dot)}
          </g>
          {accent('info-ring', INFO_ART.echo, 0.45)}
        </>
      )
    case 'columns':
      return (
        <>
          <g data-part="columns-pane" opacity="0">
            <path d={COLUMNS_ART.pane} />
          </g>
          {shape(COLUMNS_ART.frame, COLUMNS_ART.frameLine, 1.45)}
          <g data-part="columns-divider">
            {outline ? line(COLUMNS_ART.dividerLine, 1.45, 1.45) : draw(COLUMNS_ART.divider)}
          </g>
        </>
      )
    case 'calendar':
      return (
        <>
          <defs>
            <mask id={`${id}-rings`} {...MASK_BOX}>
              <rect x="-24" y="-24" width="72" height="72" fill="white" />
              <path d={CAL_ART.ringGaps} fill="black" />
            </mask>
          </defs>
          <g mask={`url(#${id}-rings)`}>
            {outline ? (
              <>
                {line(CAL_ART.bodyLine, 1.45, 1.45)}
                {line(CAL_ART.header, 1.3, 1.3)}
              </>
            ) : (
              draw(CAL_ART.body)
            )}
          </g>
          <g data-part="cal-rings">
            {outline ? line(CAL_ART.ringLines, 1.6, 1.6) : draw(CAL_ART.rings)}
          </g>
          <g data-part="cal-date">{outline ? <path d={CAL_ART.date} /> : draw(CAL_ART.date)}</g>
          {accent('cal-flash', CAL_ART.flash, 0.6)}
        </>
      )
    case 'archive':
      return (
        <>
          <g data-part="archive-sheet" opacity="0">
            <path d={ARCHIVE_ART.sheet} fill="none" stroke="currentColor" strokeWidth=".7" />
          </g>
          {outline ? (
            <>
              {line(ARCHIVE_ART.boxLine, 1.45, 1.45)}
              {line(ARCHIVE_ART.handleLine, 1.5, 1.5)}
            </>
          ) : (
            draw(ARCHIVE_ART.box)
          )}
          <g data-part="archive-lid">{shape(ARCHIVE_ART.lid, ARCHIVE_ART.lidLine, 1.4)}</g>
          {accent('archive-seat', ARCHIVE_ART.seat, 0.6)}
        </>
      )
    case 'list':
      return (
        <>
          {LIST_Y.map((y, i) => (
            <g key={y}>
              <g data-part={`list-dot-${i}`}>
                {outline ? <path d={circle(4.8, y, 1.2)} /> : draw(circle(4.8, y, 1.4))}
              </g>
              <g data-part={`list-line-${i}`}>{line(`M9 ${y}H${LIST_END[i]}`, 2, 1.6)}</g>
            </g>
          ))}
        </>
      )
    case 'heading':
      return (
        <>
          <g data-part="heading-glyph">{shape(HEADING_ART.glyph, HEADING_ART.line, 1.8)}</g>
          {accent('heading-rank', HEADING_ART.rank, 0.7)}
        </>
      )
    case 'link':
      return (
        <>
          <g data-part="link-left">{line(LINK_ART.left, 2.1, 1.6)}</g>
          <g data-part="link-right">{line(LINK_ART.right, 2.1, 1.6)}</g>
          <g data-part="link-bar">{line(LINK_ART.bar, 2.1, 1.6)}</g>
          {accent('link-spark', LINK_ART.spark, 0.6)}
        </>
      )
    case 'image':
      return (
        <>
          <defs>
            <clipPath id={`${id}-inner`}>
              <path d={IMAGE_ART.inner} />
            </clipPath>
          </defs>
          {shape(IMAGE_ART.frame, IMAGE_ART.frameLine, 1.45)}
          <g clipPath={`url(#${id}-inner)`}>
            <g data-part="image-hills">
              {outline ? line(IMAGE_ART.hillsLine, 1.4, 1.4) : draw(IMAGE_ART.hills)}
            </g>
            <g data-part="image-sun">
              {outline ? line(IMAGE_ART.sunLine, 1.2, 1.2) : draw(IMAGE_ART.sun)}
            </g>
          </g>
          {accent('image-glow', IMAGE_ART.glow, 0.45)}
        </>
      )
    case 'keyboard':
      return (
        <>
          {shape(KEYBOARD_ART.body, KEYBOARD_ART.bodyLine, 1.45)}
          {KB_KEYS.map(([x, y], i) => (
            <g key={`${x}-${y}`} data-part={i < 4 ? `kb-key-${i}` : undefined}>
              {outline ? <path d={circle(x, y, 0.85)} /> : draw(KEYBOARD_ART.keys[i])}
            </g>
          ))}
          <g data-part="kb-space">
            {outline ? line(KEYBOARD_ART.spaceLine, 1.6, 1.6) : draw(KEYBOARD_ART.space)}
          </g>
          {accent('kb-tap', KEYBOARD_ART.tap, 0.6)}
        </>
      )
  }
}

/* --------------------------------------------------------------- playback */

function keyframes(m: Motion, track: Track): Keyframe[] {
  return track.frames.map(({ at, ...frame }) => ({ ...frame, offset: at / m.duration }))
}

/** CSS fallback + transform origins, mirroring the library's styleForStudy. */
function styleFor(name: DitherExtraName): string {
  const m = extraMotions[name]
  const icon = `.dx-icon[data-dx-icon="${name}"]`
  return (
    m.tracks
      .map((track) => {
        const anim = `dx-${name}-${track.part}`
        const frames = track.frames
          .map(({ at, easing, ...props }) => {
            const body = Object.entries(props)
              .map(([k, v]) => `${k}:${v}`)
              .join(';')
            return `${(100 * at) / m.duration}%{${body}${easing ? `;animation-timing-function:${easing}` : ''}}`
          })
          .join('')
        const self = `${icon}[data-animate=true]:not([data-motion-runtime=true]):is(:hover,:focus-visible)`
        const parent = `.di-trigger:is(:hover,:focus-visible) ${icon}[data-animate=true]:not([data-motion-runtime=true])`
        return (
          `${icon} [data-part="${track.part}"]{transform-box:view-box;transform-origin:${track.origin}}` +
          `${self} [data-part="${track.part}"],${parent} [data-part="${track.part}"]{animation:${anim} ${m.duration}ms linear both}` +
          `@keyframes ${anim}{${frames}}`
        )
      })
      .join('') +
    '@media(prefers-reduced-motion:reduce){.dx-icon [data-part]{animation:none!important}}'
  )
}

function useExtraMotion(
  ref: React.RefObject<SVGSVGElement | null>,
  name: DitherExtraName,
  enabled: boolean,
  active: boolean,
  replayKey: number,
  speed: number,
  progress: number | undefined,
  texture: DitherExtraTexture
): void {
  const progressRef = useRef(progress)
  // Keep the latest progress for event handlers; runs before the effects below.
  useEffect(() => {
    progressRef.current = progress
  })
  const seekRef = useRef<(p: number | undefined) => void>(() => {})
  const playRef = useRef<() => void>(() => {})

  useEffect(() => {
    const svg = ref.current
    const m = extraMotions[name]
    if (!svg || !m || !enabled || typeof svg.animate !== 'function') return
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const target: Element = svg.closest('.di-trigger') ?? svg
    let running: Animation[] = []
    let disposed = false
    svg.dataset.motionRuntime = 'true'

    const each = (fn: (el: Element, track: Track) => Animation): Animation[] =>
      m.tracks.flatMap((track) => {
        const el = svg.querySelector(`[data-part="${track.part}"]`)
        return el ? [fn(el, track)] : []
      })
    const cancel = (): void => {
      running.forEach((a) => a.cancel())
      running = []
      delete svg.dataset.playing
    }
    const play = (): void => {
      if (
        disposed ||
        media.matches ||
        typeof progressRef.current === 'number' ||
        running.length ||
        target.matches(':disabled,[aria-disabled="true"]')
      )
        return
      svg.dataset.playing = 'true'
      running = each((el, track) =>
        el.animate(keyframes(m, track), {
          duration: m.duration / Math.max(0.1, speed),
          fill: 'both',
          easing: 'linear'
        })
      )
      const batch = running
      void Promise.allSettled(batch.map((a) => a.finished)).then(() => {
        if (running === batch) cancel()
      })
    }
    seekRef.current = (position) => {
      cancel()
      if (position === undefined || media.matches) return
      running = each((el, track) => {
        const a = el.animate(keyframes(m, track), {
          duration: m.duration,
          fill: 'both',
          easing: 'linear'
        })
        a.pause()
        a.currentTime = Math.min(1, Math.max(0, position)) * m.duration
        return a
      })
    }
    playRef.current = play
    const pointer = (event: Event): void => {
      if ((event as PointerEvent).pointerType !== 'touch') play()
    }
    const focus = (): void => {
      if (target.matches(':focus-visible')) play()
    }
    const changed = (): void => {
      if (media.matches) cancel()
      else if (progressRef.current !== undefined) seekRef.current(progressRef.current)
    }
    target.addEventListener('pointerenter', pointer)
    target.addEventListener('focusin', focus)
    target.addEventListener('click', play)
    media.addEventListener('change', changed)
    return () => {
      disposed = true
      cancel()
      playRef.current = () => {}
      seekRef.current = () => {}
      delete svg.dataset.motionRuntime
      target.removeEventListener('pointerenter', pointer)
      target.removeEventListener('focusin', focus)
      target.removeEventListener('click', play)
      media.removeEventListener('change', changed)
    }
  }, [ref, name, enabled, speed, texture])

  useEffect(() => {
    seekRef.current(progress)
  }, [progress, name, enabled, speed, texture])

  useEffect(() => {
    if (active || replayKey > 0) playRef.current()
  }, [active, replayKey, name, enabled])
}

/* ------------------------------------------------------------- components */

export const DitherExtraIcon = forwardRef<
  SVGSVGElement,
  DitherExtraProps & { name: DitherExtraName }
>(function DitherExtraIcon(
  {
    name,
    size = 24,
    texture = 'dither',
    animate = true,
    active = false,
    replayKey = 0,
    speed = 1,
    progress,
    title,
    className = '',
    ...props
  },
  ref
) {
  if (!extraMotions[name]) throw new Error(`Unknown dither-extra icon: ${name}`)
  const id = useId().replace(/:/g, '')
  const svgRef = useRef<SVGSVGElement>(null)
  useImperativeHandle(ref, () => svgRef.current as SVGSVGElement, [])
  useExtraMotion(svgRef, name, animate, active, replayKey, speed, progress, texture)
  const kit = makeKit(id, texture)
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      ref={svgRef}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      {...props}
      className={`dx-icon ${className}`.trim()}
      data-dx-icon={name}
      data-animate={animate}
      data-active={animate && active}
    >
      {title && <title>{title}</title>}
      <style>{styleFor(name)}</style>
      {texture === 'dither' && (
        <defs>
          <mask id={`${id}-grain`} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
            <path d={ditherField()} fill="white" />
          </mask>
        </defs>
      )}
      <Artwork name={name} kit={kit} />
    </svg>
  )
})

const named = (
  name: DitherExtraName,
  display: string
): ReturnType<typeof forwardRef<SVGSVGElement, DitherExtraProps>> => {
  const C = forwardRef<SVGSVGElement, DitherExtraProps>(function Named(props, ref) {
    return <DitherExtraIcon {...props} name={name} ref={ref} />
  })
  C.displayName = display
  return C
}

export const TagIcon = named('tag', 'TagIcon')
export const PinIcon = named('pin', 'PinIcon')
export const PaperclipIcon = named('paperclip', 'PaperclipIcon')
export const PencilIcon = named('pencil', 'PencilIcon')
export const EyeOffIcon = named('eye-off', 'EyeOffIcon')
export const BoldIcon = named('bold', 'BoldIcon')
export const ItalicIcon = named('italic', 'ItalicIcon')
export const MoreIcon = named('more', 'MoreIcon')
export const InfoIcon = named('info', 'InfoIcon')
export const ColumnsIcon = named('columns', 'ColumnsIcon')
export const CalendarIcon = named('calendar', 'CalendarIcon')
export const ArchiveIcon = named('archive', 'ArchiveIcon')
export const ListIcon = named('list', 'ListIcon')
export const HeadingIcon = named('heading', 'HeadingIcon')
export const LinkIcon = named('link', 'LinkIcon')
export const ImageIcon = named('image', 'ImageIcon')
export const KeyboardIcon = named('keyboard', 'KeyboardIcon')
