/** Closed-loop charge on the digital-twin step, with the study's schedule rules. */

import { energyDeliveredJ, scoreSession } from "./physics.js";

function prefixEnergy(voltage, current, n) {
  return energyDeliveredJ(voltage.slice(0, n), current.slice(0, n));
}

export function rollout(family, params, session, twin) {
  const ctx = family.init(params, session.space);
  const current = [];
  const voltage = [];
  const temperature = [];
  let v0 = session.v0 ?? twin.v0;
  let t0 = session.t0 ?? twin.t0;
  let prevI = 0;
  let end = "time budget";
  const nDec = Math.floor(session.maxMin * 60 / 30);
  const eReq = session.energyFraction * session.qAs * session.vNom;
  const socStart = session.socStart;

  const socNow = () => {
    let acc = 0;
    for (let i = 0; i < current.length; i++) acc += -current[i];
    return Math.min(1, Math.max(0, socStart + acc / session.qAs));
  };

  for (let d = 0; d < nDec; d++) {
    const state = { soc: socNow(), v0, t0, prevI };
    let target = family.target(state, ctx, params, session.space);
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
    let hit = false;
    for (let k = 0; k < pred.v.length; k++) {
      if (pred.v[k] >= ceiling) {
        cut = k + 1;
        hit = true;
        break;
      }
    }
    const vs = Array.from(pred.v.subarray(0, cut));
    const ts = Array.from(pred.t.subarray(0, cut));
    if (ctx.phase === "cv" && target !== 0 && vs.length > 0 && vs.length < 30) {
      const vHold = Math.min(vs[vs.length - 1], ceiling);
      const tHold = ts[ts.length - 1];
      while (vs.length < 30) {
        vs.push(vHold);
        ts.push(tHold);
      }
      hit = true;
    }
    const n = vs.length;
    if (n === 0) break;
    for (let k = 0; k < n; k++) {
      current.push(target);
      voltage.push(vs[k]);
      temperature.push(ts[k]);
    }
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
    let familyEnd = family.endCheck(state, ctx, params, {
      ceilingHit: hit,
      stepSamples: n,
      target,
    });
    if (session.energyMode && familyEnd === "CV cutoff current") familyEnd = null;
    if (familyEnd) {
      end = familyEnd;
      break;
    }
  }

  const metrics = scoreSession(current, voltage, temperature, session, session.weights);
  return { current, voltage, temperature, end, metrics };
}
