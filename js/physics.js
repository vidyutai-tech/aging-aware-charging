/** Trip energy and the study's session score (optimization.score_session, unchanged).
 *
 * Wear for one session is the paper's closed form:
 *   Q_cal = A_cal exp(B_cal SOC) exp(-(Ea_cal + C_cal SOC)/(R T)) t_h^z_cal  (session mean SOC and T)
 *   Q_cyc = sum_b B_b exp(-Ea_b/(R T)) (w_b Ah)^z_b                        (charge Ah, mean charge C-rate)
 * Life over many charges is in life.js.
 */

export const WH_PER_KM = 135;
export const N_CELLS = 6831;
export const KELVIN = 273.15;
export const Q_AH = 2.2;
export const SOC_START = 0.2;
export const V_MAX = 4.2;
export const I_MAX = 4.616;

export const DEG = {
  A_cal: 71011.01912693257,
  B_cal: 1.0986122886681098,
  C_cal: 0.0,
  Ea_cal: 50000.0,
  z_cal: 0.5,
  bins: [0.5, 1.0, 2.0],
  B: [4293453.763085374, 18820573.106659856, 82500940.17749056],
  Ea: [69312.6, 69312.6, 69312.6],
  z: [1.4001, 1.4001, 1.4001],
  R: 8.314,
};

export const SPACE = {
  iMin: 0.75,
  iMax: I_MAX,
  vCvMin: 4.05,
  vCvMax: 4.2,
  socSwitchMin: 0.32,
  socSwitchMax: 0.9,
  pulseOnMin: 1,
  pulseOnMax: 15,
  restFracMin: 0.5,
  restFracMax: 2.5,
  minStepDi: 0.25,
  minStageDsoc: 0.12,
  minStage1Dsoc: 0.1,
  minStageGap: 0.12,
  cvStep: 0.25,
  minCharge: 0.05,
  socStart: SOC_START,
};

export function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

export function cellWattHours(vNom) {
  return vNom * Q_AH;
}

/** Pack energy, per-cell energy, and the charge fraction the study calls energy_fraction. */
export function tripDemand(km, vNom, whPerKm = WH_PER_KM, nCells = N_CELLS) {
  const packWh = whPerKm * km;
  const cellWh = packWh / nCells;
  const fullWh = cellWattHours(vNom);
  const raw = fullWh > 0 ? cellWh / fullWh : 0;
  const room = 1 - SOC_START;
  const fraction = clamp(raw, 0, room);
  const maxKm = (room * fullWh * nCells) / whPerKm;
  return {
    km,
    whPerKm,
    nCells,
    packCapacityKwh: (fullWh * nCells) / 1000,
    packKwh: packWh / 1000,
    cellWh,
    fullWh,
    rawFraction: raw,
    energyFraction: fraction,
    capped: raw > room + 1e-9,
    maxKm,
  };
}

export function trapzUnit(y) {
  if (!y.length) return 0;
  if (y.length === 1) return y[0];
  let s = 0;
  for (let i = 1; i < y.length; i++) s += 0.5 * (y[i] + y[i - 1]);
  return s;
}

export function energyDeliveredJ(voltage, current) {
  if (!voltage.length) return 0;
  const power = new Array(voltage.length);
  for (let i = 0; i < voltage.length; i++) power[i] = -voltage[i] * current[i];
  return Math.max(0, trapzUnit(power));
}

export function tentWeights(cRate) {
  const bins = DEG.bins;
  const n = bins.length;
  const w = new Array(n).fill(0);
  const c = Math.abs(cRate);
  if (n === 1) {
    w[0] = 1;
    return w;
  }
  const cc = clamp(c, bins[0], bins[n - 1]);
  let hi = 0;
  while (hi < n && bins[hi] < cc) hi += 1;
  hi = clamp(hi, 1, n - 1);
  const lo = hi - 1;
  const span = bins[hi] - bins[lo];
  const frac = span > 0 ? (cc - bins[lo]) / span : 0;
  w[lo] = 1 - frac;
  w[hi] += frac;
  return w;
}

export function scoreSession(current, voltage, temperature, session, weights) {
  const n = current.length;
  const qAs = session.qAs;
  const soc = new Array(n);
  let acc = 0;
  for (let k = 0; k < n; k++) {
    acc += -current[k];
    soc[k] = clamp(session.socStart + acc / qAs, 0, 1);
  }
  const eDel = energyDeliveredJ(voltage, current);
  const eReq = session.energyFraction * qAs * session.vNom;
  const eNorm = eDel / Math.max(eReq, 1e-12);
  let ah = 0;
  let cSum = 0;
  let cN = 0;
  for (let k = 0; k < n; k++) {
    if (current[k] < -0.01) {
      ah += Math.abs(current[k]) / 3600;
      cSum += Math.abs(current[k]) / Q_AH;
      cN += 1;
    }
  }
  const cRate = cN ? cSum / cN : 0;
  const meanSoc = n ? soc.reduce((s, x) => s + x, 0) / n : 0;
  const meanT = n ? temperature.reduce((s, x) => s + x, 0) / n : 25;
  const tk = Math.max(meanT + 273.15, 200);
  const ms = clamp(meanSoc, 0, 1);
  const kCal = DEG.A_cal * Math.exp(DEG.B_cal * ms) * Math.exp(-(DEG.Ea_cal + DEG.C_cal * ms) / (DEG.R * tk));
  const durH = n / 3600;
  const qCal = kCal * (durH > 0 ? durH ** DEG.z_cal : 0);
  const w = tentWeights(cRate);
  let qCyc = 0;
  for (let b = 0; b < DEG.bins.length; b++) {
    const kb = DEG.B[b] * Math.exp(-DEG.Ea[b] / (DEG.R * tk));
    qCyc += kb * (w[b] * ah) ** DEG.z[b];
  }
  const deltaSoc = n ? soc[n - 1] - soc[0] : 0;
  const timeRaw = durH > 0 ? durH ** weights.zTime : 0;
  const qTotal = qCal + qCyc;
  const socTerm = weights.wSoc * deltaSoc;
  const qTerm = weights.wLoss * qTotal;
  const timeTerm = weights.wTime * timeRaw;
  let reward = 1000 * (socTerm - qTerm - timeTerm);
  if (!Number.isFinite(reward)) reward = -1e9;
  const shortfall = Math.max(0, 1 - eNorm);
  let peakV = 0;
  let peakT = 0;
  for (let k = 0; k < n; k++) {
    if (voltage[k] > peakV) peakV = voltage[k];
    if (temperature[k] > peakT) peakT = temperature[k];
  }
  const vOver = Math.max(0, peakV - session.vMax);
  const penalty = 1000 * (300 * shortfall + 100 * vOver);
  const feasible = eDel >= eReq - 1e-3 && vOver <= 1e-3;
  const durationMin = n / 60;
  const loss = -reward + 1e-3 * durationMin + penalty;
  return {
    reward, loss, feasible, socTerm, qTerm, timeTerm,
    eDel, eReq, eNorm, deltaSoc,
    socEnd: n ? soc[n - 1] : session.socStart,
    soc,
    qCalendar: qCal,
    qCyclic: qCyc,
    qTotal,
    ah, cRate, meanSoc, meanT, peakV, peakT,
    durationMin, durationH: durH,
    energyShortfall: shortfall,
    penalty,
  };
}

