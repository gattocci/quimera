/**
 * Poses and interpolation for Quimera performers.
 *
 * Maps high-level posture hints ("neutral", "attentive", "relaxed", "gesturing")
 * to specific Rig joint angles from CHIMERA's pose system.
 * Provides smooth frame-by-frame interpolation (lerp).
 */

import type { Arm, Leg, Pose } from "@chimera/rig/pose.ts";
import { neutral, pose } from "@chimera/rig/pose.ts";
import type { PostureHint } from "./scene.ts";

/** Helper to deep clone a pose. */
export function clonePose(p: Pose): Pose {
  return JSON.parse(JSON.stringify(p));
}

/** Linear interpolation between two numbers. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Interpolate Arm angles. */
function lerpArm(a: Arm, b: Arm, t: number): Arm {
  return {
    shrug: lerp(a.shrug, b.shrug, t),
    reach: lerp(a.reach, b.reach, t),
    raise: lerp(a.raise, b.raise, t),
    plane: lerp(a.plane, b.plane, t),
    rotate: lerp(a.rotate, b.rotate, t),
    elbow: lerp(a.elbow, b.elbow, t),
    turn: lerp(a.turn, b.turn, t),
    wrist: lerp(a.wrist, b.wrist, t),
    deviate: lerp(a.deviate, b.deviate, t),
  };
}

/** Interpolate Leg angles. */
function lerpLeg(a: Leg, b: Leg, t: number): Leg {
  return {
    flex: lerp(a.flex, b.flex, t),
    abduct: lerp(a.abduct, b.abduct, t),
    rotate: lerp(a.rotate, b.rotate, t),
    knee: lerp(a.knee, b.knee, t),
    ankle: lerp(a.ankle, b.ankle, t),
    invert: lerp(a.invert, b.invert, t),
    toes: lerp(a.toes, b.toes, t),
  };
}

/**
 * Smoothly blends pose `from` towards pose `to` by factor `t` (0 to 1).
 */
export function lerpPose(from: Pose, to: Pose, t: number): Pose {
  const clampT = Math.max(0, Math.min(1, t));
  return {
    body: {
      tip: lerp(from.body.tip, to.body.tip, clampT),
      lean: lerp(from.body.lean, to.body.lean, clampT),
      turn: lerp(from.body.turn, to.body.turn, clampT),
      x: lerp(from.body.x, to.body.x, clampT),
      y: lerp(from.body.y, to.body.y, clampT),
      z: lerp(from.body.z, to.body.z, clampT),
    },
    spine: {
      flex: lerp(from.spine.flex, to.spine.flex, clampT),
      bend: lerp(from.spine.bend, to.spine.bend, clampT),
      twist: lerp(from.spine.twist, to.spine.twist, clampT),
    },
    neck: {
      flex: lerp(from.neck.flex, to.neck.flex, clampT),
      bend: lerp(from.neck.bend, to.neck.bend, clampT),
      twist: lerp(from.neck.twist, to.neck.twist, clampT),
    },
    arms: {
      R: lerpArm(from.arms.R, to.arms.R, clampT),
      L: lerpArm(from.arms.L, to.arms.L, clampT),
    },
    legs: {
      R: lerpLeg(from.legs.R, to.legs.R, clampT),
      L: lerpLeg(from.legs.L, to.legs.L, clampT),
    },
  };
}

/**
 * Posture presets tailored for speech performance and listening.
 */
export const POSTURE_PRESETS: Record<PostureHint, Pose> = {
  neutral: neutral(),

  attentive: pose({
    spine: { flex: 4 },
    neck: { flex: -2 },
    bothArms: { raise: 8, plane: 10, elbow: 12 },
  }),

  relaxed: pose({
    body: { lean: 2, tip: -2 },
    spine: { flex: -2, bend: -2 },
    neck: { flex: -3, bend: 3 },
    bothArms: { raise: 6, plane: 5, elbow: 8 },
  }),

  gesturing: pose({
    spine: { flex: 3, twist: 4 },
    neck: { flex: -4, twist: -3 },
    arms: {
      R: { raise: 35, plane: 55, elbow: 65, turn: 25, wrist: 15 },
      L: { raise: 12, plane: 15, elbow: 20 },
    },
  }),
};

/**
 * Listening posture when the interlocutor is on the left (-1) or right (+1).
 */
export function listeningPose(side: -1 | 1): Pose {
  return pose({
    body: { turn: side * 8 },
    spine: { flex: 3, twist: side * 10 },
    neck: { flex: -2, twist: side * 18, bend: side * -2 },
    bothArms: { raise: 6, plane: 10, elbow: 10 },
  });
}
