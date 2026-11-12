/** Closed-loop charge on the RW9 digital twin.
 *
 * Two ways to handle the voltage limit:
 *  - "hold" (default): a charger voltage hold. When the twin first reaches the
 *    ceiling, an effective resistance is read off the twin,
 *    R = (V_ceiling - OCV(SOC)) / I, and from then on the current is
 *    I = min(schedule current, (V_ceiling - OCV(SOC)) / R), so it tapers as the
 *    cell fills. The twin still gives the temperature at that current.
 *  - "study": the rules in optimization.py. Each 30 s step that touches the
 *    ceiling lowers the current by 0.25 A, and the current never rises again.
 */

import { energyDeliveredJ, scoreSession } from "./physics.js";
import { lifeOf } from "./life.js";

const DECISION_S = 30;

function prefixEnergy(voltage, current, n) {
  return energyDeliveredJ(voltage.slice(0, n), current.slice(0, n));
}

export function rollout(family, params, session, twin) {
  const ctx = family.init(params, session.space);
  const current = [];
  const voltage = [];
  const temperature = [];
  const hold = session.cvMode !== "study";
  const cv = { active: false, r: null, startS: null };
  let v0 = twin.v0;
  let t0 = twin.t0;
  let prevI = 0;
  let end = "time budget";
  const nDec = Math.floor((session.maxMin * 60) / DECISION_S);
  const eReq = session.energyFraction * session.qAs * session.vNom;
  const socStart = session.socStart;
  let charge = 0;
  const socNow = () => Math.min(1, Math.max(0, socStart + charge / session.qAs));
  const minCharge = session.space.minCharge;

  for (let d = 0; d < nDec; d++) {
    const state = { soc: socNow(), v0, t0, prevI };
    let target = family.target(state, ctx, params, session.space);
    let vs;
    let ts;
    let amps;
    let hit = false;

    if (hold) {
      const ceiling = family.ceiling(params, session.vMax, { phase: "cv" });
      const sched = Math.abs(target);
      amps = sched;
      if (cv.active && sched > 0) {
        const room = ceiling - twin.ocv(state.soc);
        amps = Math.min(sched, Math.max(0, room / cv.r));
        if (amps < minCharge) {
          end = "Voltage hold tapered out";
          break;
        }
        const pred = twin.stepResponse(ceiling, t0, amps, Math.abs(prevI));
        vs = new Array(DECISION_S).fill(ceiling);
        ts = Array.from(pred.t);
      } else {
        const pred = twin.stepResponse(v0, t0, sched, Math.abs(prevI));
        vs = Array.from(pred.v);
        ts = Array.from(pred.t);
        if (sched > 0) {
          const k = vs.findIndex((v) => v >= ceiling);
          if (k >= 0) {
            // Switch to the voltage hold at the crossing sample.
            const socK = Math.min(1, state.soc + (sched * (k + 1)) / session.qAs);
            cv.active = true;
            cv.startS = current.length + k;
            cv.r = Math.max(0.01, (ceiling - twin.ocv(socK)) / sched);
            for (let j = k; j < DECISION_S; j++) {
              vs[j] = ceiling;
              ts[j] = ts[k];
            }
          }
        }
      }
      target = -amps;
    } else {
      // Study rules, as in optimization.ChargingSimulator.simulate.
      if (session.energyMode && family.id === "cccv" && ctx.phase === "cv" && target !== 0) {
        const iHold = Math.max(params.i_cutoff, 0.1, 0.1 * params.i_cc);
        if (Math.abs(target) + 1e-9 < iHold) {
          target = -iHold;
          ctx.iLevel = iHold;
        }
      }
      const ceiling = family.ceiling(params, session.vMax, ctx);
      const pred = twin.stepResponse(v0, t0, Math.abs(target), Math.abs(prevI));
      let cut = pred.v.length;
      for (let k = 0; k < pred.v.length; k++) {
        if (pred.v[k] >= ceiling) {
          cut = k + 1;
          hit = true;
          break;
        }
      }
      vs = Array.from(pred.v.subarray(0, cut));
      ts = Array.from(pred.t.subarray(0, cut));
      if (ctx.phase === "cv" && target !== 0 && vs.length > 0 && vs.length < DECISION_S) {
        const vHold = Math.min(vs[vs.length - 1], ceiling);
        const tHold = ts[ts.length - 1];
        while (vs.length < DECISION_S) {
          vs.push(vHold);
          ts.push(tHold);
        }
        hit = true;
      }
    }

    const n = vs.length;
    if (n === 0) break;
    for (let k = 0; k < n; k++) {
      current.push(target);
      voltage.push(vs[k]);
      temperature.push(ts[k]);
    }
    charge += -target * n;
    if (target !== 0 && !ctx.inRest) ctx.chargeElapsed += n;
    v0 = vs[n - 1];
    t0 = ts[n - 1];
    prevI = target;

    if (session.energyMode && prefixEnergy(voltage, current, current.length) >= eReq - 1e-3) {
      let lo = Math.max(1, current.length - n);
      let hi = current.length;
      let at = hi;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (prefixEnergy(voltage, current, mid) >= eReq - 1e-3) {
          at = mid;
          hi = mid;
        } else {
          lo = mid + 1;
        }
      }
      current.length = at;
      voltage.length = at;
      temperature.length = at;
      end = "energy target";
      break;
    }

    const early = family.after(state, ctx, params, {
      ceilingHit: hit,
      vTraj: vs,
      globalCeiling: session.vMax,
      sp: session.space,
    });
    if (early) {
      end = early;
      break;
    }
    const soc = socNow();
    if (session.energyMode) {
      if (soc >= 1 - 1e-6) {
        end = "SoC full";
        break;
      }
    } else if (soc >= socStart + session.energyFraction) {
      end = "SoC target";
      break;
    }
    let familyEnd = hold ? null : family.endCheck(state, ctx, params, { ceilingHit: hit, stepSamples: n, target });
    if (session.energyMode && familyEnd === "CV cutoff current") familyEnd = null;
    if (familyEnd) {
      end = familyEnd;
      break;
    }
  }

  const metrics = scoreSession(current, voltage, temperature, session, session.weights);
  metrics.life = lifeOf({ current, temperature, soc: metrics.soc }, session);
  metrics.cvStartMin = cv.startS != null && cv.startS < current.length ? cv.startS / 60 : null;
  metrics.objective = objectiveLoss(metrics, session);
  return { current, voltage, temperature, end, metrics };
}

/** Loss the search minimises. "life": fewest replacements; "study": paper Eq. 10. */
export function objectiveLoss(m, session) {
  if (session.objective === "study") return m.loss;
  const perCharge = m.life.perChargeLoss;
  const base = perCharge > 0 ? 1000 * Math.log(perCharge) : 1e9;
  // Same feasibility penalties as the study score, plus its small duration tie-break.
  return base + 1e-3 * m.durationMin + m.penalty;
}
