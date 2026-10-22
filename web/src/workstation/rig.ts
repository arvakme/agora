// The workers' procedural rig (web/docs/workstation.md §小人).
//
// Inspired by Loom Studio (loom-studio-sep-2026.moldandyeast.com, by RM / moldandyeast), whose page
// describes its figures: poses solved every frame with no keyframes, second-order dynamics on the
// body and joints, two-bone IK for arms and legs, and footsteps planned ahead so feet plant. None
// of its code is used here; this is an independent implementation of those published techniques
// (first written for the 工位视图 prototype, then ported here).
//
// What keeps replay exact:
//   - WHAT a worker does and WHERE its hands and feet are is a pure function of the timeline time t
//     (stateAt in ./place.ts, planTrip / tripAt here). Scrubbing to t and playing up to t agree.
//   - Springs only smooth hands, lean and head between those targets. On a jump (seek, time going
//     backwards, a long gap) they are reset to the target, so a paused frame is always the exact pose.
// Times are milliseconds; lengths are figure units (1 unit = 1 CSS px at scale 1), ground y = 0, up −y.
//
// Split in three: ./rigCore.ts (springs, IK, proportions), ./rigTrip.ts (trips), ./rigPose.ts (poses, solve).

export * from "./rigCore";
export * from "./rigTrip";
export * from "./rigPose";
