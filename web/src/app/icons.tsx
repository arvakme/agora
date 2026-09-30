/**
 * The one icon facade for Agora (design-system.md §8, same shape as Marginalia's ui/icons.tsx).
 *
 * Every UI icon comes from Dither Icons (@unlocalhosted/dither-icons, MIT, © 2026 Unlocalhosted;
 * names checked against its icons.json), from Marginalia's extra icons drawn in the same
 * construction (./dither-extra, MIT derivative), or — where neither has the glyph — is drawn
 * here on the same 24-unit grid as an outline (marked "drawn" below). Call sites only write
 * `<IconX size={16} />`; this file decides colour, texture and motion:
 *   - colour: the accent, `var(--icon, var(--accent))`. Put `--icon` on a container to change it
 *     (on a filled purple button it is `--accent-fg`).
 *   - texture: solid up to 20px, dither from 40px (empty states, offline and share pages).
 *   - motion: the library's one-shot gesture on hover / focus-visible / click of the whole
 *     control. The facade tags the nearest interactive ancestor with `di-trigger`, so call sites
 *     never have to. `active` / `replayKey` replay it on state changes. Never loops.
 * The comment teardrop is Agora's own mark (the pin's shape) and stays drawn.
 */
import {
  ArrowLeftIcon,
  CheckIcon,
  CloseIcon,
  CodeIcon,
  CopyIcon,
  CpuIcon,
  ExternalLinkIcon,
  EyeIcon,
  ExpandViewIcon,
  NetworkIcon,
  SparklesIcon,
  FileIcon,
  FolderIcon,
  GaugeIcon,
  HintIcon,
  HistoryIcon,
  LayersIcon,
  LockIcon,
  MessageIcon,
  MoonIcon,
  NextWordIcon,
  PathIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  PreviousWordIcon,
  RetryIcon,
  SearchIcon,
  SendIcon,
  SunIcon,
  TargetIcon,
  TerminalIcon,
  TrashIcon,
  UserIcon,
  WorkspaceIcon,
} from "@unlocalhosted/dither-icons";
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, type CSSProperties, type ForwardRefExoticComponent, type ReactNode, type RefAttributes } from "react";
import { ListIcon, MoreIcon, PencilIcon, PinIcon } from "./dither-extra";

export type IconProps = { size?: number; active?: boolean; replayKey?: number; title?: string; className?: string; style?: CSSProperties };
type Icon = ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>>;
type LibIcon = ForwardRefExoticComponent<IconProps & { texture?: "dither" | "solid" | "outline" } & RefAttributes<SVGSVGElement>>;

const COLOR = "var(--icon, var(--accent))";
const TRIGGER_HOST = 'button, a[href], summary, label, [role="button"], [role="menuitem"], [role="tab"], [role="option"], [role="radio"]';

/** Tags the closest interactive ancestor with `di-trigger` before the icon runtime looks for it. */
function useTrigger(forwarded: React.ForwardedRef<SVGSVGElement>) {
  const node = useRef<SVGSVGElement | null>(null);
  useImperativeHandle(forwarded, () => node.current as SVGSVGElement, []);
  useLayoutEffect(() => {
    const svg = node.current;
    if (!svg || svg.closest(".di-trigger")) return;
    svg.parentElement?.closest(TRIGGER_HOST)?.classList.add("di-trigger");
  });
  return node;
}

function dither(Base: unknown, name: string): Icon {
  const B = Base as LibIcon;
  const C = forwardRef<SVGSVGElement, IconProps>(function DitherFacade({ size = 16, className, style, ...rest }, ref) {
    const node = useTrigger(ref);
    return <B ref={node} size={size} texture={size >= 40 ? "dither" : "solid"} className={className ? `ag-icon ${className}` : "ag-icon"} style={{ color: COLOR, flexShrink: 0, ...style }} {...rest} />;
  });
  C.displayName = name;
  return C;
}

/** Drawn here: 24-unit grid, centre-line outline at 1.6 (1.5 at 16px), round caps, like the library's outline texture. */
function drawn(art: ReactNode, name: string, fill = false): Icon {
  const C = forwardRef<SVGSVGElement, IconProps>(function DrawnIcon({ size = 16, className, style, title, active: _a, replayKey: _r }, ref) {
    void _a;
    void _r;
    return (
      <svg
        ref={ref}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill={fill ? "currentColor" : "none"}
        stroke={fill ? "none" : "currentColor"}
        strokeWidth={size <= 14 ? 1.9 : 1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className ? `ag-icon ${className}` : "ag-icon"}
        style={{ color: COLOR, flexShrink: 0, ...style }}
        aria-hidden={title ? undefined : true}
        role={title ? "img" : undefined}
        aria-label={title}
      >
        {art}
      </svg>
    );
  });
  C.displayName = name;
  return C;
}

// ——— Dither Icons (icons.json names in comments) ———
export const IconPlus = dither(PlusIcon, "IconPlus"); // plus
export const IconClose = dither(CloseIcon, "IconClose"); // close
export const IconCheck = dither(CheckIcon, "IconCheck"); // check
export const IconLayers = dither(LayersIcon, "IconLayers"); // layers — 所有画布
export const IconWorkspace = dither(WorkspaceIcon, "IconWorkspace"); // workspace — brand mark
export const IconTrash = dither(TrashIcon, "IconTrash"); // trash — delete, clear canvas
export const IconCopy = dither(CopyIcon, "IconCopy"); // copy
export const IconSearch = dither(SearchIcon, "IconSearch"); // search
export const IconFolder = dither(FolderIcon, "IconFolder"); // folder — asset library
export const IconSend = dither(SendIcon, "IconSend"); // send — 发送, 交给 Agent
export const IconMessage = dither(MessageIcon, "IconMessage"); // message — 对话, 新建会话
export const IconPath = dither(PathIcon, "IconPath"); // path — 轨迹
export const IconHistory = dither(HistoryIcon, "IconHistory"); // history
export const IconTerminal = dither(TerminalIcon, "IconTerminal"); // terminal
export const IconCode = dither(CodeIcon, "IconCode"); // code — 代码路径
export const IconTarget = dither(TargetIcon, "IconTarget"); // target — progress pointer, highlight
export const IconHint = dither(HintIcon, "IconHint"); // hint — outside the diagram, warnings, system
export const IconCpu = dither(CpuIcon, "IconCpu"); // cpu — model
export const IconGauge = dither(GaugeIcon, "IconGauge"); // gauge — usage
export const IconShare = dither(ExternalLinkIcon, "IconShare"); // external-link — 分享
export const IconLock = dither(LockIcon, "IconLock"); // lock — locked binding, revoke
export const IconEye = dither(EyeIcon, "IconEye"); // eye — view only
export const IconUser = dither(UserIcon, "IconUser"); // user
export const IconFile = dither(FileIcon, "IconFile"); // file
export const IconRetry = dither(RetryIcon, "IconRetry"); // retry — reopen thread, replay, reset player
export const IconPlay = dither(PlayIcon, "IconPlay"); // play
export const IconPause = dither(PauseIcon, "IconPause"); // pause
export const IconPrev = dither(PreviousWordIcon, "IconPrev"); // previous-word — player step back
export const IconNext = dither(NextWordIcon, "IconNext"); // next-word — player step forward
export const IconBack = dither(ArrowLeftIcon, "IconBack"); // arrow-left
export const IconEnter = dither(ExpandViewIcon, "IconEnter"); // expand-view — 进入子图
export const IconNested = dither(NetworkIcon, "IconNested"); // network — 子图
export const IconSparkles = dither(SparklesIcon, "IconSparkles"); // sparkles — the one AI entry of a view (让 AI 展开 / 更新)
export const IconSun = dither(SunIcon, "IconSun"); // sun — light theme
export const IconMoon = dither(MoonIcon, "IconMoon"); // moon — dark theme

// ——— Marginalia's dither-extra (same construction) ———
export const IconPencil = dither(PencilIcon, "IconPencil"); // rename
export const IconList = dither(ListIcon, "IconList"); // 所有评论
export const IconPin = dither(PinIcon, "IconPin"); // "pinned to" (the comment anchor)
export const IconMore = dither(MoreIcon, "IconMore");

// ——— drawn (no match in either set) ———
/** The comment mark: the pin's own teardrop (¾ circle, square bottom-left corner). */
export const COMMENT_PATH = "M4.5 19.5V12a7.5 7.5 0 1 1 7.5 7.5Z";
export const IconComment = drawn(<path d={COMMENT_PATH} />, "IconComment");
export const IconCommentSolid = drawn(<path d={COMMENT_PATH} />, "IconCommentSolid", true);
/** Undo: a hooked arrow back (neither set has one). */
export const IconUndo = drawn(<path d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />, "IconUndo");
/** Browse / select tool: the pointer arrow. */
export const IconPointer = drawn(<path d="M5.5 4.5 11 19l2.1-6.4 6.4-2.1Z" />, "IconPointer");
/** Comment on the selection: selection corners around a small teardrop. */
export const IconSelect = drawn(
  <>
    <path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4" />
    <path d="M9.5 14.5V12a2.5 2.5 0 1 1 2.5 2.5Z" />
  </>,
  "IconSelect",
);
/** Layout presets: one pane, side by side, stacked, grid. */
export const IconSingle = drawn(<rect x="4" y="5" width="16" height="14" rx="2" />, "IconSingle");
export const IconCols = drawn(<><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M12 5v14" /></>, "IconCols");
export const IconRows = drawn(<><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M4 12h16" /></>, "IconRows");
export const IconGrid = drawn(<><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M12 5v14M4 12h16" /></>, "IconGrid");
/** System default theme: half sun, half dark. */
export const IconAuto = drawn(<><circle cx="12" cy="12" r="7.5" /><path d="M12 4.5v15a7.5 7.5 0 0 0 0-15Z" fill="currentColor" stroke="none" /></>, "IconAuto");

/** Structural disclosure chevron (not an icon in the library sense): drawn, 1.5 stroke, accent. */
export const IconChevron = ({ size = 12, open = false }: { size?: number; open?: boolean }) => (
  <svg className="ag-icon ag-chevron" data-open={open} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={(1.5 * 24) / size} strokeLinecap="round" strokeLinejoin="round" style={{ color: COLOR, flexShrink: 0 }} aria-hidden>
    <path d="M9 6l6 6-6 6" />
  </svg>
);
