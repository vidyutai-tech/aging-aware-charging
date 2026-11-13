/** Charging schedules: constant-current/constant-voltage, two-step, three-step, pulsed. */

import { SPACE, clamp } from "./physics.js?v=3";

function twoSoc(sp) {
  const hi = sp.socSwitchMax;
  const lo = Math.min(sp.socStart + sp.minStageDsoc, hi - 1e-3);
  return [lo, Math.max(lo + 1e-3, hi)];
}

function threeSoc(sp) {
  const hi = sp.socSwitchMax;
  const soc1Lo = Math.min(sp.socStart + sp.minStage1Dsoc, hi - sp.minStageGap - 1e-3);
  const soc1Hi = Math.max(soc1Lo + 1e-3, Math.min(0.55, hi - sp.minStageGap));
  const soc2Lo = soc1Lo + sp.minStageGap;
  const soc2Hi = Math.max(soc2Lo + 1e-3, hi);
  return [[soc1Lo, soc1Hi], [soc2Lo, soc2Hi]];
}

/* Discrete current mode (optimization.py _place_currents): snap to the nearest level, ties to the lower one,
 * and keep each later step current at or below the one before. Off when sp.levels is empty. */
function snapTo(x, levels) {
  let best = levels[0];
  for (const l of levels) if (Math.abs(l - x) < Math.abs(best - x) - 1e-12) best = l;
  return best;
}

function descending(values, levels) {
  const out = [];
  let cap = null;
  for (const raw of values) {
    const snapped = snapTo(raw, levels);
    if (cap == null) out.push(snapped);
    else {
      const allowed = levels.filter((l) => l <= cap + 1e-9);
      out.push(allowed.length ? snapTo(snapped, allowed) : cap);
    }
    cap = out[out.length - 1];
  }
  return out;
}

function placeCurrents(values, sp) {
  const levels = sp.levels;
  if (!levels || !levels.length) return values;
  const out = { ...values };
  if ("i_cc" in out) out.i_cc = snapTo(out.i_cc, levels);
  const keys = ["i1", "i2", "i3"].filter((k) => k in out);
  if (keys.length) descending(keys.map((k) => out[k]), levels).forEach((l, i) => { out[keys[i]] = l; });
  if ("i_charge" in out && "i_floor" in out) [out.i_charge, out.i_floor] = descending([out.i_charge, out.i_floor], levels);
  return out;
}

function uniqueSeeds(rows, clip) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const params = clip(row);
    const key = JSON.stringify(params);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(params);
  }
  return out;
}

export const FAMILIES = {
  cccv: {
    id: "cccv",
    label: "Constant current, then voltage hold",
    short: "CCCV",
    bounds(sp = SPACE) {
      return {
        i_cc: [sp.iMin, sp.iMax],
        v_cv: [sp.vCvMin, sp.vCvMax],
        i_cutoff: [0.01, Math.min(0.5, sp.iMax - sp.cvStep)],
      };
    },
    clip(values, sp = SPACE) {
      const iCc = clamp(values.i_cc, sp.iMin, sp.iMax);
      const vCv = clamp(values.v_cv, sp.vCvMin, sp.vCvMax);
      const iCut = clamp(values.i_cutoff, 0.01, Math.min(0.5, iCc - sp.cvStep));
      return placeCurrents({ i_cc: iCc, v_cv: vCv, i_cutoff: iCut }, sp);
    },
    seeds(sp = SPACE) {
      const ref = { i_cc: 2, v_cv: 4.2, i_cutoff: 0.05 };
      const rows = [ref];
      for (const iCc of [sp.iMin, 0.5 * (sp.iMin + sp.iMax), sp.iMax]) {
        rows.push({ i_cc: iCc, v_cv: sp.vCvMax, i_cutoff: ref.i_cutoff });
      }
      for (const vCv of [sp.vCvMin, 0.5 * (sp.vCvMin + sp.vCvMax), sp.vCvMax]) {
        rows.push({ i_cc: ref.i_cc, v_cv: vCv, i_cutoff: ref.i_cutoff });
      }
      return uniqueSeeds(rows, (row) => this.clip(row, sp));
    },
    sample(rng, sp = SPACE) {
      const b = this.bounds(sp);
      const raw = {};
      for (const [k, [lo, hi]] of Object.entries(b)) raw[k] = lo + rng() * (hi - lo);
      return this.clip(raw, sp);
    },
    init(params) {
      return { phase: "cc", iLevel: params.i_cc, chargeElapsed: 0, restElapsed: 0, inRest: false };
    },
    target(_state, ctx, params) {
      if (ctx.phase === "cc") return -params.i_cc;
      return -Math.max(ctx.iLevel, params.i_cutoff);
    },
    ceiling(params, globalCeiling, ctx) {
      if (ctx.phase === "cv") return Math.min(globalCeiling, params.v_cv);
      return globalCeiling;
    },
    after(_state, ctx, params, info) {
      const peak = info.vTraj.reduce((m, x) => Math.max(m, x), -Infinity);
      if (ctx.phase === "cc") {
        if (info.ceilingHit || peak >= params.v_cv - 1e-4) {
          ctx.phase = "cv";
          ctx.iLevel = params.i_cc;
        }
        return null;
      }
      if (ctx.phase === "cv" && info.ceilingHit) {
        ctx.iLevel = Math.max(params.i_cutoff, ctx.iLevel - info.sp.cvStep);
      }
      return null;
    },
    endCheck(_state, ctx, params, info) {
      if (ctx.phase === "cv" && info.target !== 0) {
        if (ctx.iLevel <= params.i_cutoff + 1e-6 && info.ceilingHit && info.stepSamples <= 1) {
          return "CV cutoff current";
        }
      }
      return null;
    },
  },

  two_step: {
    id: "two_step",
    label: "Two charge rates",
    short: "Two-step",
    bounds(sp = SPACE) {
      const [lo, hi] = twoSoc(sp);
      return {
        i1: [Math.min(sp.iMin + sp.minStepDi, sp.iMax), sp.iMax],
        i2: [sp.iMin, sp.iMax],
        soc_switch: [lo, hi],
      };
    },
    clip(values, sp = SPACE) {
      const [socLo, socHi] = twoSoc(sp);
      const i1Raw = values.i1;
      const i2Raw = values.i2;
      let i1;
      let i2;
      let socSw;
      if (Math.abs(i1Raw - i2Raw) < 1e-9) {
        i1 = clamp(i1Raw, sp.iMin, sp.iMax);
        i2 = i1;
        socSw = clamp(values.soc_switch ?? socLo, socLo, socHi);
      } else {
        i1 = clamp(i1Raw, sp.iMin + sp.minStepDi, sp.iMax);
        i2 = clamp(i2Raw, sp.iMin, Math.max(sp.iMin, i1 - sp.minStepDi));
        socSw = clamp(values.soc_switch, socLo, socHi);
      }
      return placeCurrents({ i1, i2, soc_switch: socSw }, sp);
    },
    seeds(sp = SPACE) {
      const [socLo, socHi] = twoSoc(sp);
      const mid = 0.5 * (socLo + socHi);
      const rows = [
        { i1: Math.min(3, sp.iMax), i2: Math.max(sp.iMin, 1.5), soc_switch: mid },
        { i1: Math.min(2, sp.iMax), i2: Math.max(sp.iMin, 1), soc_switch: mid },
        { i1: Math.min(4, sp.iMax), i2: Math.max(sp.iMin, 2), soc_switch: socLo },
        { i1: sp.iMax, i2: Math.max(sp.iMin, 0.5 * (sp.iMin + sp.iMax)), soc_switch: socHi },
      ];
      return uniqueSeeds(rows, (row) => this.clip(row, sp));
    },
    sample(rng, sp = SPACE) {
      const [socLo, socHi] = twoSoc(sp);
      const i1 = sp.iMin + sp.minStepDi + rng() * (sp.iMax - sp.iMin - sp.minStepDi);
      const i2 = sp.iMin + rng() * Math.max(0, i1 - sp.minStepDi - sp.iMin);
      return this.clip({ i1, i2, soc_switch: socLo + rng() * (socHi - socLo) }, sp);
    },
    init(params, sp = SPACE) {
      const iLevel = params.i1;
      return { phase: "cc", iLevel, chargeElapsed: 0, restElapsed: 0, inRest: false, socStart: sp.socStart };
    },
    target(state, ctx, params) {
      ctx.iLevel = state.soc < params.soc_switch ? params.i1 : params.i2;
      return -ctx.iLevel;
    },
    ceiling(_params, globalCeiling) {
      return globalCeiling;
    },
    after(_state, ctx, _params, info) {
      if (info.ceilingHit) ctx.iLevel = Math.max(info.sp.minCharge, ctx.iLevel - info.sp.cvStep);
      return null;
    },
    endCheck() {
      return null;
    },
  },

  three_step: {
    id: "three_step",
    label: "Three charge rates",
    short: "Three-step",
    bounds(sp = SPACE) {
      const [[s1lo, s1hi], [s2lo, s2hi]] = threeSoc(sp);
      return {
        i1: [Math.min(sp.iMin + 2 * sp.minStepDi, sp.iMax), sp.iMax],
        i2: [sp.iMin, sp.iMax],
        i3: [sp.iMin, sp.iMax],
        soc1: [s1lo, s1hi],
        soc2: [s2lo, s2hi],
      };
    },
    clip(values, sp = SPACE) {
      const [[s1lo, s1hi], [s2lo, s2hi]] = threeSoc(sp);
      const flat = Math.abs(values.i1 - values.i2) < 1e-9 && Math.abs(values.i2 - values.i3) < 1e-9;
      let i1;
      let i2;
      let i3;
      if (flat) {
        i1 = i2 = i3 = clamp(values.i1, sp.iMin, sp.iMax);
      } else {
        i1 = clamp(values.i1, sp.iMin + 2 * sp.minStepDi, sp.iMax);
        i2 = clamp(values.i2, sp.iMin + sp.minStepDi, Math.max(sp.iMin + sp.minStepDi, i1 - sp.minStepDi));
        i3 = clamp(values.i3, sp.iMin, Math.max(sp.iMin, i2 - sp.minStepDi));
      }
      const soc1 = clamp(values.soc1, s1lo, s1hi);
      const soc2 = clamp(values.soc2, Math.max(s2lo, soc1 + sp.minStageGap), s2hi);
      return placeCurrents({ i1, i2, i3, soc1, soc2 }, sp);
    },
    seeds(sp = SPACE) {
      const [[s1lo, s1hi], [, s2hi]] = threeSoc(sp);
      const mid1 = 0.5 * (s1lo + s1hi);
      const rows = [
        { i1: Math.min(3, sp.iMax), i2: Math.min(2, sp.iMax), i3: Math.max(sp.iMin, 1), soc1: mid1, soc2: mid1 + sp.minStageGap },
        { i1: Math.min(4, sp.iMax), i2: Math.min(2.5, sp.iMax), i3: Math.max(sp.iMin, 1.25), soc1: s1lo, soc2: s1lo + sp.minStageGap },
        { i1: sp.iMax, i2: Math.max(sp.iMin + sp.minStepDi, 0.6 * sp.iMax), i3: sp.iMin, soc1: mid1, soc2: Math.min(s2hi, mid1 + 0.2) },
      ];
      return uniqueSeeds(rows, (row) => this.clip(row, sp));
    },
    sample(rng, sp = SPACE) {
      const [[s1lo, s1hi], [s2lo, s2hi]] = threeSoc(sp);
      const i1 = sp.iMin + 2 * sp.minStepDi + rng() * (sp.iMax - (sp.iMin + 2 * sp.minStepDi));
      const i2hi = Math.max(sp.iMin + sp.minStepDi, i1 - sp.minStepDi);
      const i2 = sp.iMin + sp.minStepDi + rng() * (i2hi - (sp.iMin + sp.minStepDi));
      const i3 = sp.iMin + rng() * Math.max(0, i2 - sp.minStepDi - sp.iMin);
      const soc1 = s1lo + rng() * (s1hi - s1lo);
      const floor = Math.max(s2lo, soc1 + sp.minStageGap);
      const soc2 = floor + rng() * Math.max(1e-6, s2hi - floor);
      return this.clip({ i1, i2, i3, soc1, soc2 }, sp);
    },
    init(params) {
      return { phase: "cc", iLevel: params.i1, chargeElapsed: 0, restElapsed: 0, inRest: false };
    },
    target(state, ctx, params) {
      if (state.soc < params.soc1) ctx.iLevel = params.i1;
      else if (state.soc < params.soc2) ctx.iLevel = params.i2;
      else ctx.iLevel = params.i3;
      return -ctx.iLevel;
    },
    ceiling(_params, globalCeiling) {
      return globalCeiling;
    },
    after(_state, ctx, _params, info) {
      if (info.ceilingHit) ctx.iLevel = Math.max(info.sp.minCharge, ctx.iLevel - info.sp.cvStep);
      return null;
    },
    endCheck() {
      return null;
    },
  },

  pulsed: {
    id: "pulsed",
    label: "Pulsed charge and rest",
    short: "Pulsed",
    bounds(sp = SPACE) {
      return {
        i_charge: [sp.iMin, sp.iMax],
        pulse_on_min: [sp.pulseOnMin, sp.pulseOnMax],
        rest_fraction: [sp.restFracMin, sp.restFracMax],
        i_floor: [sp.iMin, sp.iMax],
      };
    },
    clip(values, sp = SPACE) {
      const iCc = clamp(values.i_charge, sp.iMin, sp.iMax);
      const pulseOn = clamp(values.pulse_on_min, sp.pulseOnMin, sp.pulseOnMax);
      const restFrac = clamp(values.rest_fraction, sp.restFracMin, sp.restFracMax);
      const iFloor = clamp(values.i_floor, sp.iMin, Math.min(iCc - 0.05, sp.iMax));
      return placeCurrents({
        i_charge: iCc,
        pulse_on_min: pulseOn,
        pulse_rest_min: Math.max(0.5, pulseOn * restFrac),
        rest_fraction: restFrac,
        i_floor: iFloor,
      }, sp);
    },
    seeds(sp = SPACE) {
      const base = { i_charge: 1, pulse_on_min: 10, rest_fraction: 2, i_floor: 0.75 };
      const rows = [
        base,
        { ...base, i_charge: sp.iMax },
        { ...base, i_charge: 0.5 * (sp.iMin + sp.iMax) },
      ];
      return uniqueSeeds(rows, (row) => this.clip(row, sp));
    },
    sample(rng, sp = SPACE) {
      const iCharge = sp.iMin + rng() * (sp.iMax - sp.iMin);
      return this.clip({
        i_charge: iCharge,
        pulse_on_min: sp.pulseOnMin + rng() * (sp.pulseOnMax - sp.pulseOnMin),
        rest_fraction: sp.restFracMin + rng() * (sp.restFracMax - sp.restFracMin),
        i_floor: sp.iMin + rng() * Math.max(0, iCharge - 0.05 - sp.iMin),
      }, sp);
    },
    init(params) {
      return {
        phase: "pulsed",
        iLevel: params.i_charge,
        chargeElapsed: 0,
        restElapsed: 0,
        inRest: false,
        pulseOnS: params.pulse_on_min * 60,
        pulseRestS: params.pulse_rest_min * 60,
        iFloor: params.i_floor,
      };
    },
    target(_state, ctx) {
      if (ctx.inRest) return 0;
      if (ctx.pulseRestS > 0 && ctx.chargeElapsed >= ctx.pulseOnS) {
        ctx.inRest = true;
        ctx.restElapsed = 0;
        return 0;
      }
      return -ctx.iLevel;
    },
    ceiling(_params, globalCeiling) {
      return globalCeiling;
    },
    after(_state, ctx, _params, info) {
      if (ctx.inRest) {
        ctx.restElapsed += info.vTraj.length;
        if (ctx.restElapsed >= ctx.pulseRestS) {
          ctx.inRest = false;
          ctx.chargeElapsed = 0;
        }
      } else if (info.ceilingHit && ctx.iLevel > ctx.iFloor + 1e-9) {
        ctx.iLevel = Math.max(ctx.iFloor, ctx.iLevel - info.sp.cvStep);
        ctx.chargeElapsed = 0;
      }
      return null;
    },
    endCheck(_state, ctx, _params, info) {
      if (info.ceilingHit && ctx.iLevel <= ctx.iFloor + 1e-9 && info.target !== 0 && info.stepSamples <= 1) {
        return "V ceiling @ min current";
      }
      return null;
    },
  },
};

export function baselineParams(cRate) {
  return FAMILIES.cccv.clip({
    i_cc: cRate * 2.2,
    v_cv: 4.2,
    i_cutoff: 0.05,
  });
}

export function describeParams(familyId, params) {
  if (familyId === "cccv") {
    return `Hold ${params.i_cc.toFixed(2)} A until ${params.v_cv.toFixed(2)} V, then taper to ${params.i_cutoff.toFixed(2)} A`;
  }
  if (familyId === "two_step") {
    return `${params.i1.toFixed(2)} A until ${Math.round(params.soc_switch * 100)}% charge, then ${params.i2.toFixed(2)} A`;
  }
  if (familyId === "three_step") {
    return `${params.i1.toFixed(2)} A, then ${params.i2.toFixed(2)} A from ${Math.round(params.soc1 * 100)}%, then ${params.i3.toFixed(2)} A from ${Math.round(params.soc2 * 100)}%`;
  }
  return `${params.i_charge.toFixed(2)} A for ${params.pulse_on_min.toFixed(1)} min, rest ${params.pulse_rest_min.toFixed(1)} min, floor ${params.i_floor.toFixed(2)} A`;
}

export const END_TEXT = {
  "energy target": "Trip energy delivered",
  "time budget": "Stopped at the time limit",
  "SoC full": "State of charge is full",
  "SoC target": "Requested charge added",
  "CV cutoff current": "Tapered to the cutoff current",
  "V ceiling @ min current": "Voltage limit at the lowest current",
};
