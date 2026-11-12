/** Pack life over many charges: calendar plus cyclic aging on real elapsed time.
 *
 * The study's degradation model is a pair of power laws:
 *   Q_cal = k_cal(SOC, T) * t_h^z_cal          k_cal = A_cal e^(B_cal SOC) e^(-(Ea_cal + C_cal SOC)/(R T))
 *   Q_cyc = sum_b k_b(T) * Ah_b^z_b            k_b   = B_b e^(-Ea_b/(R T)), Ah split over C-rate nodes b
 *
 * Because the exponents are not 1, the loss of N charges is not N times the loss
 * of one charge. Losses are accumulated with equivalent-time integration (the
 * method described in optimization.py for time-varying stress):
 *   u_cal = sum_i k_cal(SOC_i, T_i)^(1/z_cal) dt_i      Q_cal = u_cal^z_cal
 *   u_b   = sum_i k_b(T_i)^(1/z_b) dAh_i,b             Q_cyc = sum_b u_b^z_b
 *
 * One cycle of use = this charge (second by second, from the twin) plus the time
 * until the next charge, parked at the average of the start and end SOC at the
 * parking temperature. Calendar aging therefore runs on calendar time, not just
 * on the minutes spent charging. Cyclic throughput counts charge ampere-hours,
 * as in the study's fit.
 */

import { DEG, KELVIN, Q_AH, tentWeights } from "./physics.js";

const kelvin = (c) => Math.max(c + KELVIN, 200);

export function kCal(soc, tC) {
  const s = Math.min(1, Math.max(0, soc));
  return DEG.A_cal * Math.exp(DEG.B_cal * s) * Math.exp(-(DEG.Ea_cal + DEG.C_cal * s) / (DEG.R * kelvin(tC)));
}

export function kCyc(b, tC) {
  return DEG.B[b] * Math.exp(-DEG.Ea[b] / (DEG.R * kelvin(tC)));
}

/** Per-cycle accumulators from one charge trace plus the idle time that follows it. */
export function cycleIncrements(trace, usage, socStart) {
  const { current, temperature, soc } = trace;
  const n = current.length;
  const zc = DEG.z_cal;
  let uCalCharge = 0;
  const uB = DEG.bins.map(() => 0);
  for (let i = 0; i < n; i++) {
    uCalCharge += kCal(soc[i], temperature[i]) ** (1 / zc) / 3600;
    const amps = -current[i];
    if (amps > 0.01) {
      const w = tentWeights(amps / Q_AH);
      const dAh = amps / 3600;
      for (let b = 0; b < uB.length; b++) {
        if (w[b] > 0) uB[b] += kCyc(b, temperature[i]) ** (1 / DEG.z[b]) * w[b] * dAh;
      }
    }
  }
  const chargeH = n / 3600;
  const socEnd = n ? soc[n - 1] : socStart;
  const parkSoc = 0.5 * (socStart + socEnd);
  const idleH = Math.max(0, usage.hoursBetween - chargeH);
  const uCalIdle = kCal(parkSoc, usage.parkC) ** (1 / zc) * idleH;
  return { uCalCharge, uCalIdle, uCal: uCalCharge + uCalIdle, uB, chargeH, idleH, parkSoc };
}

export function lossAfter(nCharges, inc) {
  const qCal = (nCharges * inc.uCal) ** DEG.z_cal;
  let qCyc = 0;
  for (let b = 0; b < inc.uB.length; b++) qCyc += (nCharges * inc.uB[b]) ** DEG.z[b];
  return { qCal, qCyc, q: qCal + qCyc };
}

/** Charges until capacity falls to eolPct, by bisection in log space. */
export function chargesTo(target, inc) {
  if (lossAfter(1e8, inc).q < target) return Infinity;
  let lo = 0;
  let hi = Math.log(1e8);
  for (let k = 0; k < 80; k++) {
    const mid = 0.5 * (lo + hi);
    if (lossAfter(Math.exp(mid), inc).q < target) lo = mid;
    else hi = mid;
  }
  return Math.exp(0.5 * (lo + hi));
}

export function lifeOf(trace, session) {
  const usage = session.usage;
  const inc = cycleIncrements(trace, usage, session.socStart);
  const target = 1 - usage.eolPct / 100;
  const n = chargesTo(target, inc);
  const atEol = Number.isFinite(n) ? lossAfter(n, inc) : { qCal: 0, qCyc: 0, q: 0 };
  const first = lossAfter(1, inc);
  return {
    ...inc,
    target,
    charges: n,
    years: (n * usage.hoursBetween) / 8760,
    calShare: atEol.q > 0 ? atEol.qCal / atEol.q : 0,
    qCalEol: atEol.qCal,
    qCycEol: atEol.qCyc,
    firstChargeLoss: first.q,
    perChargeLoss: Number.isFinite(n) ? target / n : 1e-12,
  };
}

/** Remaining capacity (%) after each number of charges, for plotting. */
export function capacityCurve(life, nMax, points = 200) {
  const x = [];
  const y = [];
  const cal = [];
  for (let k = 0; k <= points; k++) {
    const n = (nMax * k) / points;
    const q = lossAfter(n, life);
    x.push(n);
    y.push(Math.max(0, 100 * (1 - q.q)));
    cal.push(Math.max(0, 100 * (1 - q.qCal)));
  }
  return { x, y, cal };
}
