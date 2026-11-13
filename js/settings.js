/** Advanced settings: every research value the plan uses, its default, and the panel that edits it.
 * Defaults come from physics.js (config.py in the research code). readSettings() turns the panel
 * into the objects the session, search, score and wear model read. */

import { DEG, SPACE, V_MAX } from "./physics.js";

const TWIN_I_MAX = 4.616; // highest current in the twin table
const TWIN_V_MAX = 4.3; // highest voltage in the twin table

export const GROUPS = [
  {
    title: "Charge limits",
    items: [
      { key: "vMax", label: "Voltage limit", unit: "V", def: V_MAX, min: 3.9, max: TWIN_V_MAX, step: 0.01 },
      { key: "iMin", label: "Lowest charge current", unit: "A", def: SPACE.iMin, min: 0.05, max: TWIN_I_MAX, step: 0.05 },
      { key: "iMax", label: "Highest charge current", unit: "A", def: SPACE.iMax, min: 0.1, max: TWIN_I_MAX, step: 0.05 },
      { key: "cvStep", label: "Current drop each time the voltage limit is hit", unit: "A", def: SPACE.cvStep, min: 0.01, max: 2, step: 0.05 },
      { key: "minCharge", label: "Lowest current after drops (step schedules)", unit: "A", def: SPACE.minCharge, min: 0, max: 2, step: 0.01 },
    ],
  },
  {
    title: "CCCV",
    items: [
      { key: "vCvMin", label: "Lowest hold voltage", unit: "V", def: SPACE.vCvMin, min: 3.9, max: TWIN_V_MAX, step: 0.01 },
      { key: "vCvMax", label: "Highest hold voltage", unit: "V", def: SPACE.vCvMax, min: 3.9, max: TWIN_V_MAX, step: 0.01 },
    ],
  },
  {
    title: "Two-step and three-step",
    items: [
      { key: "minStepDi", label: "Smallest gap between step currents", unit: "A", def: SPACE.minStepDi, min: 0, max: 2, step: 0.05 },
      { key: "socSwitchMax", label: "Latest switch point", unit: "%", def: SPACE.socSwitchMax, scale: 100, min: 10, max: 100, step: 1 },
      { key: "minStageDsoc", label: "Two-step: switch at least this far above the start", unit: "%", def: SPACE.minStageDsoc, scale: 100, min: 0, max: 80, step: 1 },
      { key: "minStage1Dsoc", label: "Three-step: first switch at least this far above the start", unit: "%", def: SPACE.minStage1Dsoc, scale: 100, min: 0, max: 80, step: 1 },
      { key: "minStageGap", label: "Three-step: gap between the two switches", unit: "%", def: SPACE.minStageGap, scale: 100, min: 0, max: 80, step: 1 },
    ],
  },
  {
    title: "Pulsed",
    items: [
      { key: "pulseOnMin", label: "Shortest charging period", unit: "min", def: SPACE.pulseOnMin, min: 0.5, max: 180, step: 0.5 },
      { key: "pulseOnMax", label: "Longest charging period", unit: "min", def: SPACE.pulseOnMax, min: 0.5, max: 180, step: 0.5 },
      { key: "restFracMin", label: "Shortest rest, as a share of the charging period", unit: "×", def: SPACE.restFracMin, min: 0, max: 10, step: 0.1 },
      { key: "restFracMax", label: "Longest rest, as a share of the charging period", unit: "×", def: SPACE.restFracMax, min: 0, max: 10, step: 0.1 },
    ],
  },
  {
    title: "Discrete currents",
    note: "As --discrete-current in the research code: every current snaps to the nearest level, and each later step stays at or below the one before. The CCCV comparison charges are not snapped.",
    items: [
      { key: "discrete", label: "Use discrete current levels", type: "check", def: true },
      { key: "levels", label: "Levels", unit: "A", type: "text", def: "1.0, 1.5, 2.0, 3.0, 4.5" },
    ],
  },
  {
    title: "Study score",
    note: "Score = 1000 × (charge weight × charge added − wear weight × wear − time weight × hours^exponent).",
    items: [
      { key: "wSoc", label: "Charge added weight", def: 2.5, step: 0.1 },
      { key: "wLoss", label: "Wear weight", def: 7500, step: 100, wide: true },
      { key: "wTime", label: "Time weight", def: 1.1, step: 0.1 },
      { key: "zTime", label: "Time exponent", def: 0.55, step: 0.05 },
      { key: "penShort", label: "Penalty for missing the trip energy", def: 300, step: 10 },
      { key: "penVolt", label: "Penalty per volt over the limit", def: 100, step: 10 },
      { key: "durW", label: "Extra cost per minute", def: 1e-3, step: 0.001 },
    ],
  },
  {
    title: "Search",
    items: [
      { key: "random", label: "Random search", type: "check", def: true },
      { key: "gp", label: "Bayesian search (Gaussian process)", type: "check", def: true },
      { key: "nCalls", label: "Tries per schedule type and method", def: 80, min: 1, max: 2000, step: 1, int: true },
      { key: "nInitial", label: "Starting tries before the Bayesian model", def: 15, min: 1, max: 2000, step: 1, int: true },
      { key: "acq", label: "Bayesian pick rule", type: "select", def: "EI", options: [["EI", "Expected improvement"], ["PI", "Probability of improvement"], ["LCB", "Lower confidence bound"]] },
      { key: "xi", label: "Exploration margin", def: 0.01, min: 0, step: 0.01 },
      { key: "gpLength", label: "Model length scale", def: 0.35, min: 0.01, max: 10, step: 0.05 },
      { key: "seed", label: "Random seed", def: 20260904, min: 0, step: 1, int: true, wide: true },
    ],
  },
  {
    title: "Wear model",
    note: "Calendar: A·e^(B·SOC)·e^(−Ea/RT)·hours^z. Cycling: B·e^(−Ea/RT)·Ah^z at 0.5C, 1C and 2C.",
    items: [
      { key: "A_cal", label: "Calendar A", def: DEG.A_cal, wide: true },
      { key: "B_cal", label: "Calendar B (charge level)", def: DEG.B_cal, wide: true },
      { key: "Ea_cal", label: "Calendar Ea", unit: "J/mol", def: DEG.Ea_cal, wide: true },
      { key: "z_cal", label: "Calendar exponent z", def: DEG.z_cal, wide: true },
      { key: "B0", label: "Cycling B at 0.5C", def: DEG.B[0], wide: true },
      { key: "B1", label: "Cycling B at 1C", def: DEG.B[1], wide: true },
      { key: "B2", label: "Cycling B at 2C", def: DEG.B[2], wide: true },
      { key: "EaCyc", label: "Cycling Ea", unit: "J/mol", def: DEG.Ea[0], wide: true },
      { key: "zCyc", label: "Cycling exponent z", def: DEG.z[0], wide: true },
      { key: "lifeRef", label: "Cycles to 80% for CCCV 0.5C", def: 600, min: 1, step: 10, int: true },
    ],
  },
  {
    title: "Twin and comparison charges",
    items: [
      { key: "t0", label: "Starting cell temperature", unit: "°C", def: 24, min: 18, max: 30, step: 0.5 },
      { key: "baselineMaxMin", label: "Time allowed for the CCCV comparison charges", unit: "min", def: 150, min: 5, max: 600, step: 5 },
    ],
  },
];

const ITEMS = GROUPS.flatMap((g) => g.items);
const idOf = (key) => `adv-${key}`;
const shown = (it) => (it.scale ? +(it.def * it.scale).toFixed(6) : it.def);

function field(it) {
  const id = idOf(it.key);
  if (it.type === "check") {
    return `<label class="inline"><input type="checkbox" id="${id}"${it.def ? " checked" : ""}> ${it.label}</label>`;
  }
  if (it.type === "select") {
    const opts = it.options.map(([v, t]) => `<option value="${v}"${v === it.def ? " selected" : ""}>${t}</option>`).join("");
    return `<label for="${id}">${it.label}</label><select id="${id}">${opts}</select>`;
  }
  const attrs = it.type === "text"
    ? `type="text" class="wide" value="${it.def}"`
    : `type="number" step="${it.step ?? "any"}"${it.min != null ? ` min="${it.min}"` : ""}${it.max != null ? ` max="${it.max}"` : ""} value="${shown(it)}"${it.wide ? ' class="wide"' : ""}`;
  return `<label for="${id}">${it.label}</label><span class="num small"><input id="${id}" ${attrs}>${it.unit ? `<span class="unit">${it.unit}</span>` : ""}</span>`;
}

/** Fill the panel and keep the "changed" count up to date. */
export function buildAdvanced(grid, countEl, resetBtn) {
  grid.innerHTML = GROUPS.map((g) => `<fieldset><legend>${g.title}</legend>${g.note ? `<p class="adv-note">${g.note}</p>` : ""}${g.items.map(field).join("")}</fieldset>`).join("");
  const update = () => {
    const n = ITEMS.filter((it) => isChanged(it)).length;
    countEl.textContent = n ? `${n} changed` : "";
  };
  grid.addEventListener("input", update);
  grid.addEventListener("change", update);
  resetBtn.addEventListener("click", () => {
    for (const it of ITEMS) {
      const el = document.getElementById(idOf(it.key));
      if (it.type === "check") el.checked = it.def;
      else el.value = it.type === "number" || !it.type ? shown(it) : it.def;
    }
    update();
  });
  update();
}

function isChanged(it) {
  const el = document.getElementById(idOf(it.key));
  if (it.type === "check") return el.checked !== it.def;
  if (it.type === "select" || it.type === "text") return el.value.trim() !== String(it.def);
  return el.value !== "" && Number(el.value) !== shown(it);
}

function readOne(it) {
  const el = document.getElementById(idOf(it.key));
  if (it.type === "check") return el.checked;
  if (it.type === "select" || it.type === "text") return el.value.trim();
  let v = el.value === "" ? NaN : Number(el.value);
  if (!Number.isFinite(v)) return it.def; // blank or invalid falls back to the default
  if (it.min != null) v = Math.max(it.min, v);
  if (it.max != null) v = Math.min(it.max, v);
  if (it.int) v = Math.round(v);
  return it.scale ? v / it.scale : v;
}

/** Read the panel. Returns { cfg, errors }. */
export function readSettings() {
  const v = {};
  for (const it of ITEMS) v[it.key] = readOne(it);
  const errors = [];
  let levels = null;
  if (v.discrete) {
    levels = [...new Set(v.levels.split(/[\s,;]+/).map(Number).filter((x) => Number.isFinite(x) && x > 0))].sort((a, b) => a - b);
    if (!levels.length) errors.push("Enter at least one discrete current level.");
  }
  if (v.iMin >= v.iMax) errors.push("The lowest charge current must be below the highest.");
  if (v.vCvMin > v.vCvMax) errors.push("The lowest CCCV hold voltage must not be above the highest.");
  if (v.pulseOnMin > v.pulseOnMax) errors.push("The shortest pulsed charging period must not be longer than the longest.");
  if (v.restFracMin > v.restFracMax) errors.push("The shortest pulsed rest must not be longer than the longest.");
  const methods = [v.random && "random_search", v.gp && "gp_bo"].filter(Boolean);
  if (!methods.length) errors.push("Select at least one search method.");

  const cfg = {
    vMax: v.vMax,
    t0: v.t0,
    baselineMaxMin: v.baselineMaxMin,
    lifeRef: v.lifeRef,
    space: {
      ...SPACE,
      iMin: v.iMin,
      iMax: v.iMax,
      vCvMin: v.vCvMin,
      vCvMax: v.vCvMax,
      socSwitchMax: v.socSwitchMax,
      minStepDi: v.minStepDi,
      minStageDsoc: v.minStageDsoc,
      minStage1Dsoc: v.minStage1Dsoc,
      minStageGap: v.minStageGap,
      pulseOnMin: v.pulseOnMin,
      pulseOnMax: v.pulseOnMax,
      restFracMin: v.restFracMin,
      restFracMax: v.restFracMax,
      cvStep: v.cvStep,
      minCharge: v.minCharge,
      levels,
    },
    weights: {
      wSoc: v.wSoc, wLoss: v.wLoss, wTime: v.wTime, zTime: v.zTime,
      penShort: v.penShort, penVolt: v.penVolt, durW: v.durW,
    },
    deg: {
      ...DEG,
      A_cal: v.A_cal, B_cal: v.B_cal, Ea_cal: v.Ea_cal, z_cal: v.z_cal,
      B: [v.B0, v.B1, v.B2],
      Ea: DEG.bins.map(() => v.EaCyc),
      z: DEG.bins.map(() => v.zCyc),
    },
    search: {
      methods,
      nCalls: v.nCalls,
      nInitial: v.nInitial,
      acq: v.acq,
      xi: v.xi,
      gpLength: v.gpLength,
      seed: v.seed,
    },
  };
  return { cfg, errors };
}
