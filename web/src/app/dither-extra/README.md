# dither-extra

Copied unchanged from Marginalia (the same author's notes app, `ui/dither-extra/`) so Agora uses the same extra icons as the family (design-system.md §8). Agora imports them only through `../icons.tsx`.

These 17 icons fill the gaps in [Dither Icons](https://dithered.dev) (`@unlocalhosted/dither-icons`, source at github.com/vijayksingh/dither-icons). They are tag, pin, paperclip, pencil, eye-off, bold, italic, more, info, columns, calendar, archive, list, heading, link, image and keyboard.

They are **derived in the style of Dither Icons** and follow its construction:

- a 24×24 viewBox, painted in `currentColor`;
- the same three textures: `dither` draws the shape at 16% opacity, then draws it again through the library's ordered-dither mask (8×8 Bayer, 0.25-unit dots, darker toward the lower right); `solid` fills the shape; `outline` draws centre-line strokes of 1.3–1.9;
- a one-shot motion for each icon, built from the library's authoring pieces (`motion` / `actor` / `pose` / `light`, three named stages, the `settle` / `smooth` / `accelerate` easings, about 0.8–1.1 s). Accent parts sit at opacity 0 until the motion runs;
- the same playback rules: Web Animations run on hover, `:focus-visible` or click of the icon or its closest `.di-trigger`. `active` plays once each time it becomes true. `replayKey` replays. `prefers-reduced-motion`, `animate={false}` and unmount cancel a running motion. When the runtime is missing, a CSS fallback plays on hover.

The `eye-off` icon reuses the library's own eye geometry (`EYE_ART`) so that it pairs with `eye`. The ordered-dither field is rebuilt with the library's formula. Everything else was drawn new for Marginalia.

## API

```tsx
import { PinIcon, DitherExtraIcon } from './ui/dither-extra'

<button className="icon-btn di-trigger" aria-label="钉住面板">
  <PinIcon size={16} texture="solid" active={pinned} />
</button>
<DitherExtraIcon name="tag" size={16} texture="outline" animate={false} />
```

The props are the library's: `size`, `texture` (`dither` | `solid` | `outline`), `animate`, `active`, `replayKey`, `speed`, `progress`, `title`, plus any SVG attribute. The ref is forwarded. Without a `title` the icon is `aria-hidden`.

Geometry, motion tracks and `extraDefinitions` (name, caption, stages, duration) are in `art.ts`. The components are in `index.tsx`.

**Status:** wired into Marginalia through `ui/icons.tsx` (in Agora: `app/icons.tsx`), the single icon facade. The module does not import `@unlocalhosted/dither-icons`, so it works with or without that package installed.

## Licence

Dither Icons is MIT licensed, Copyright (c) 2026 Unlocalhosted. These icons are a derivative of its construction, and the reused eye geometry comes from it directly. Keep `LICENSE-dither-icons.txt` next to this module, and keep the notice in the header of `index.tsx`.
