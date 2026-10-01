import type { BuildInfo } from "../persist";

const SHORT_SHA = 7;

/** The corner label for the code the page's server runs; null when the server did not say (an old build, or no git). */
export function buildLabel(build: BuildInfo | undefined): { text: string; title: string } | null {
  if (!build?.sha) return null;
  const short = build.sha.slice(0, SHORT_SHA);
  if (build.dirty === null) return { text: `${short}?`, title: `${build.sha}（未确认是否有未提交的改动）` };
  return build.dirty ? { text: `${short}+`, title: `${build.sha}（有未提交的改动）` } : { text: short, title: build.sha };
}
