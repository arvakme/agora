import type { BuildInfo } from "../persist";
import { tr } from "../i18n";

const SHORT_SHA = 7;

/** The corner label for the code the page's server runs: its commit in a checkout, its package version when installed; null when the server did not say. */
export function buildLabel(build: BuildInfo | undefined): { text: string; title: string } | null {
  if (!build?.sha) return build?.version ? { text: `v${build.version}`, title: `agora-canvas ${build.version}` } : null;
  const short = build.sha.slice(0, SHORT_SHA);
  if (build.dirty === null) return { text: `${short}?`, title: tr(`${build.sha}（未确认是否有未提交的改动）`, `${build.sha} (uncommitted changes unknown)`) };
  return build.dirty ? { text: `${short}+`, title: tr(`${build.sha}（有未提交的改动）`, `${build.sha} (uncommitted changes)`) } : { text: short, title: build.sha };
}
