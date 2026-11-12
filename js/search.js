/** Random search and a Gaussian-process search on the study score. */

import { FAMILIES } from "./profiles.js";

const FAMILY_ORDER = ["cccv", "two_step", "three_step", "pulsed"];
import { rollout } from "./simulate.js";

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function erf(x) {
  const sign = Math.sign(x);
  const ax = Math.abs(x);
  const p = 0.3275911;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

function phi(z) {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

function Phi(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function namesOf(family, space) {
  return Object.keys(family.bounds(space));
}

function normalize(params, family, space) {
  const bounds = family.bounds(space);
  return namesOf(family, space).map((name) => {
    const [lo, hi] = bounds[name];
    return hi > lo ? (params[name] - lo) / (hi - lo) : 0;
  });
}

function fromUnit(u, family, space, rngJitter) {
  const bounds = family.bounds(space);
  const names = namesOf(family, space);
  const raw = {};
  names.forEach((name, i) => {
    const [lo, hi] = bounds[name];
    let z = u[i];
    if (rngJitter) z = Math.min(1, Math.max(0, z + (rngJitter() - 0.5) * 1e-4));
    raw[name] = lo + Math.min(1, Math.max(0, z)) * (hi - lo);
  });
  return family.clip(raw, space);
}

function cholesky(a) {
  const n = a.length;
  const L = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = a[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) L[i][j] = Math.sqrt(Math.max(sum, 1e-12));
      else L[i][j] = sum / L[j][j];
    }
  }
  return L;
}

function solveLower(L, b) {
  const y = new Float64Array(L.length);
  for (let i = 0; i < L.length; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
    y[i] = s / L[i][i];
  }
  return y;
}

function solveUpper(L, y) {
  const x = new Float64Array(L.length);
  for (let i = L.length - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < L.length; k++) s -= L[k][i] * x[k];
    x[i] = s / L[i][i];
  }
  return x;
}

function rbf(a, b, length) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] - b[i]) / length;
    s += d * d;
  }
  return Math.exp(-0.5 * s);
}

function propose(xs, ys, family, space, rng, acq, xi) {
  const n = xs.length;
  const dim = xs[0].length;
  let mean = 0;
  for (const y of ys) mean += y;
  mean /= n;
  let sf = 0;
  for (const y of ys) sf += (y - mean) ** 2;
  sf = Math.max(sf / n, 1e-8);
  const length = 0.35;
  const noise = 1e-6 * sf + 1e-9;
  const K = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      const v = sf * rbf(xs[i], xs[j], length) + (i === j ? noise : 0);
      K[i][j] = v;
      K[j][i] = v;
    }
  }
  const L = cholesky(K);
  const y0 = Float64Array.from(ys, (y) => y - mean);
  const alpha = solveUpper(L, solveLower(L, y0));
  let bestY = Infinity;
  for (const y of ys) if (y < bestY) bestY = y;

  const candidates = [];
  const count = Math.max(64, 40 * dim);
  for (let c = 0; c < count; c++) {
    const u = [];
    for (let d = 0; d < dim; d++) u.push(rng());
    candidates.push(u);
  }
  let pick = candidates[0];
  let pickScore = -Infinity;
  for (const u of candidates) {
    const k = new Float64Array(n);
    for (let i = 0; i < n; i++) k[i] = sf * rbf(u, xs[i], length);
    const mu = mean + k.reduce((s, ki, i) => s + ki * alpha[i], 0);
    const v = solveLower(L, k);
    let varTerm = sf;
    for (let i = 0; i < n; i++) varTerm -= v[i] * v[i];
    const sigma = Math.sqrt(Math.max(varTerm, 1e-12));
    let score;
    if (acq === "PI") {
      score = Phi((bestY - mu - xi) / sigma);
    } else if (acq === "LCB") {
      score = -(mu - 1.96 * sigma);
    } else {
      const z = (bestY - mu - xi) / sigma;
      score = sigma * (z * Phi(z) + phi(z));
    }
    if (score > pickScore) {
      pickScore = score;
      pick = u;
    }
  }
  return fromUnit(pick, family, space);
}

function consider(row, top) {
  top.push(row);
  top.sort((a, b) => a.loss - b.loss);
  if (top.length > 400) top.length = 400;
}

async function searchFamily(family, session, twin, opts, method, onTick) {
  const rng = mulberry32(opts.seed);
  const history = [];
  const seeds = family.seeds(session.space);
  const nRandomExtra = Math.max(0, opts.nInitial - seeds.length);
  const nCalls = method === "random_search"
    ? opts.nCalls
    : Math.max(opts.nCalls, seeds.length + nRandomExtra);

  const evalParams = (params) => {
    const out = rollout(family, params, session, twin);
    const row = {
      familyId: family.id,
      family: family.short,
      method,
      params,
      loss: out.metrics.objective,
      reward: out.metrics.reward,
      feasible: out.metrics.feasible,
      metrics: out.metrics,
      end: out.end,
    };
    delete row.metrics.soc;
    history.push(row);
    return row;
  };

  for (const params of seeds) {
    if (history.length >= nCalls) break;
    const row = evalParams(params);
    if (onTick) await onTick(row);
  }
  if (method === "random_search") {
    while (history.length < nCalls) {
      const row = evalParams(family.sample(rng, session.space));
      if (onTick) await onTick(row);
    }
  } else {
    while (history.length < seeds.length + nRandomExtra && history.length < nCalls) {
      const row = evalParams(family.sample(rng, session.space));
      if (onTick) await onTick(row);
    }
    while (history.length < nCalls) {
      const xs = history.map((h) => normalize(h.params, family, session.space));
      const ys = history.map((h) => h.loss);
      let params;
      try {
        params = propose(xs, ys, family, session.space, rng, opts.acq, 0.01);
      } catch {
        params = family.sample(rng, session.space);
      }
      const row = evalParams(params);
      if (onTick) await onTick(row);
    }
  }
  return history;
}

const CURRENT_KEYS = {
  cccv: ["i_cc"],
  two_step: ["i1", "i2"],
  three_step: ["i1", "i2", "i3"],
  pulsed: ["i_charge", "i_floor"],
};

/** Keep a schedule's shape and change its pace: scale every current by the same
 * factor, so the schedule uses the time available instead of finishing early or late. */
async function refinePace(family, rows, session, twin, method, onRow) {
  const out = [];
  for (const base of rows) {
    for (let k = 0.7; k <= 1.3001; k += 0.03) {
      if (Math.abs(k - 1) < 1e-9) continue;
      const raw = { ...base.params };
      for (const key of CURRENT_KEYS[family.id]) raw[key] = base.params[key] * k;
      const params = family.clip(raw, session.space);
      const res = rollout(family, params, session, twin);
      const row = { familyId: family.id, family: family.short, method, params, loss: res.metrics.objective,
        reward: res.metrics.reward, feasible: res.metrics.feasible, metrics: res.metrics, end: res.end };
      delete row.metrics.soc;
      out.push(row);
      await onRow(row);
    }
  }
  return out;
}

export async function planCharge(session, twin, options, onProgress) {
  const families = options.families.map((id) => FAMILIES[id]).filter(Boolean);
  const methods = options.methods;
  const feasible = [];
  const fallback = [];
  let tested = 0;
  const budget = families.length * methods.length * (options.nCalls + 60);
  for (let m = 0; m < methods.length; m++) {
    for (let f = 0; f < families.length; f++) {
      // Seed by schedule type, so a type gives the same answer whatever else is ticked.
      const seed = (options.seed + m * 1009 + FAMILY_ORDER.indexOf(families[f].id) * 17) >>> 0;
      const onRow = async (row) => {
        tested += 1;
        consider(row, row.feasible ? feasible : fallback);
        if (tested % 2 === 0 && onProgress) {
          onProgress(Math.min(1, tested / Math.max(budget, 1)), tested);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      };
      const history = await searchFamily(families[f], session, twin, { ...options, seed }, methods[m], onRow);
      // Refine the pace of this type's three best feasible schedules (or best three if none finish).
      const ok = history.filter((h) => h.feasible);
      const bestRows = (ok.length ? ok : history).slice().sort((a, b) => a.loss - b.loss).slice(0, 3);
      await refinePace(families[f], bestRows, session, twin, methods[m], onRow);
    }
  }
  const pool = feasible.length ? feasible : fallback;
  // Best of each schedule type first, then the next best overall, up to six.
  const bestOf = new Map();
  for (const row of pool) if (!bestOf.has(row.familyId)) bestOf.set(row.familyId, row);
  const top = [...bestOf.values()].sort((a, b) => a.loss - b.loss);
  for (const row of pool) if (top.length < 6 && !top.includes(row)) top.push(row);
  return { top, tested };
}
