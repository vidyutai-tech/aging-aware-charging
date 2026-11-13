/* Distance and time are the only inputs. Everything else follows the research
 * code (Final_Aging_aware_charging_opt): the RW9 twin, the four schedule types,
 * the study score, and the 600-charge lifetime anchor. Sources are in physics.js. */

import { mountChart } from "./charts.js";
import { FAMILIES, baselineParams, describeParams } from "./profiles.js";
import { N_CELLS, SOC_START, SPACE, V_MAX, WH_PER_KM, lifeToEighty, retentionCurve, tripDemand } from "./physics.js";
import { planCharge } from "./search.js";
import { rollout } from "./simulate.js";
import { loadTwin } from "./twin.js";

/* Research settings (config.py). */
const RESEARCH = {
  weights: { wSoc: 2.5, wLoss: 7500, wTime: 1.1, zTime: 0.55 }, // RewardSpec
  baselineMaxMin: 150, // SessionSpec.max_duration_min
  families: ["cccv", "two_step", "three_step", "pulsed"],
  methods: ["random_search", "gp_bo"],
  nCalls: 80,
  nInitial: 15,
  acq: "EI",
  seed: 20260904, // master_seed
};

const $ = (id) => document.getElementById(id);
const form = $("planner");
const out = $("out");
const statusEl = $("status");
const progress = $("progress");
const bar = $("bar");
const go = $("go");
const twin = loadTwin(globalThis.PACK_DATA);
const charts = {};

function fmt(n, digits = 1) {
  if (n == null || !Number.isFinite(n)) return "–";
  return n.toLocaleString("en-IN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function vehicle() {
  const eff = Number($("eff").value); // kWh/km
  const whkm = eff > 0 ? eff * 1000 : 0;
  const cells = Math.round(Number($("cells").value));
  return { whkm: whkm > 0 ? whkm : WH_PER_KM, cells: cells > 0 ? cells : N_CELLS };
}

function updatePackNote() {
  const v = vehicle();
  const d = tripDemand(Number($("km").value) || 0, twin.vNom, v.whkm, v.cells);
  $("pack-note").textContent = `Pack: ${v.cells.toLocaleString("en-IN")} cells of ${fmt(d.fullWh, 2)} Wh, about ${fmt(d.packCapacityKwh, 1)} kWh. Each charge starts at ${Math.round(SOC_START * 100)}%. Between charges the car is parked at the average of its start and end charge.`;
}

function sessionFor(fraction, maxMin) {
  return {
    socStart: SOC_START,
    energyFraction: fraction,
    maxMin,
    energyMode: true,
    vMax: V_MAX,
    vNom: twin.vNom,
    qAs: twin.qAs,
    weights: RESEARCH.weights,
    space: SPACE,
  };
}

function series(trace, name, color, dash) {
  const t = trace.current.map((_, i) => i / 60);
  return {
    amps: { name, color, dash, x: t, y: trace.current.map((c) => Math.max(0, -c)) },
    volt: { name, color, dash, x: t, y: trace.voltage },
    temp: { name, color, dash, x: t, y: trace.temperature },
    soc: { name, color, dash, x: t, y: trace.metrics.soc.map((v) => v * 100) },
  };
}

function draw(id, spec) {
  if (!charts[id]) charts[id] = mountChart($(id));
  charts[id].set(spec);
}

function legend(limit = false) {
  return `<div class="legend"><span><i class="sw best"></i>Recommended</span><span><i class="sw ref"></i>CCCV 0.5C</span>${limit ? '<span><i class="sw lim"></i>4.2 V limit</span>' : ""}</div>`;
}

const rupees = (n) => `₹${Math.round(n).toLocaleString("en-IN")}`;

function lifeBars(rows, best, life, cost) {
  const items = rows.map((row) => {
    const pick = row.familyId === best.familyId;
    const pct = row.feasible ? (life(row.metrics) / 600 - 1) * 100 : null;
    return { name: row.family, pick, pct };
  });
  const span = Math.max(5, ...items.map((it) => Math.abs(it.pct ?? 0)));
  // Money saved = % change in cycles to 80% × battery cost (negative means extra cost).
  const money = (pct) => {
    const v = (pct / 100) * cost;
    return v >= 0 ? `<b>${rupees(v)}</b> saved` : `<b>${rupees(-v)}</b> extra cost`;
  };
  return `<div class="bars"><div class="bars-head"><span>Schedule</span><span></span><span>Cycles</span><span>Money saved</span></div>${items.map((it) => {
    if (it.pct == null) return `<div class="bar-row"><span class="bar-name">${it.name}</span><span class="bar-track"></span><span class="bar-val muted">Did not finish in time</span><span class="bar-money">–</span></div>`;
    const w = (Math.abs(it.pct) / span) * 50;
    const side = it.pct >= 0 ? `left:50%;width:${w}%` : `left:${50 - w}%;width:${w}%`;
    return `<div class="bar-row${it.pick ? " pick" : ""}"><span class="bar-name">${it.name}${it.pick ? " (recommended)" : ""}</span><span class="bar-track"><i class="${it.pct >= 0 ? "up" : "down"}" style="${side}"></i></span><span class="bar-val ${it.pct >= 0 ? "up" : "down"}">${it.pct >= 0 ? "+" : "−"}${fmt(Math.abs(it.pct), 1)}%</span><span class="bar-money">${money(it.pct)}</span></div>`;
  }).join("")}</div>`;
}

function render(req, d, baselines, best, top, tested, byFamily) {
  const half = baselines[0];
  const qHalf = half.metrics.qTotal;
  const life = (m) => lifeToEighty(m.qTotal, qHalf).cycles;
  // Time saved against CCCV 0.5C, as a share of its charge time.
  const faster = best.metrics.feasible && half.metrics.durationMin > 0
    ? (1 - best.metrics.durationMin / half.metrics.durationMin) * 100
    : null;
  const gain = faster != null && faster >= 1 ? `<div class="vcard gain"><div class="k">Benefit</div><div class="v">${fmt(faster, 0)}%</div><div class="s">faster charging than CCCV 0.5C</div></div>` : "";
  const warn = [];
  if (d.capped) warn.push(`A charge from 20% cannot hold this whole trip. The plan uses the largest charge that fits, enough for about ${fmt(d.maxKm, 0)} km.`);
  if (!best.metrics.feasible) warn.push(`No schedule delivered the trip energy within ${fmt(req.minutes, 0)} min and 4.2 V. Allow more time or a shorter trip.`);

  out.innerHTML = `
  <section class="result" aria-labelledby="res-title">
    <h2 class="result-title" id="res-title">The recommended charge</h2>
    <p class="result-lede">${tested} schedules were tried on the RW9 digital twin. The one shown has the highest study score among those that deliver the trip energy within ${fmt(req.minutes, 0)} min.</p>
    ${warn.map((t) => `<div class="banner">${t}</div>`).join("")}

    <div class="verdict">
      <div>
        <div class="big">${best.family}</div>
        <p class="big-sub">${describeParams(best.familyId, best.params)}</p>
      </div>
      <div class="vcard best"><div class="k">Recommended</div><div class="v">${fmt(best.metrics.durationMin, 1)} min</div><div class="s">${best.metrics.feasible ? `${fmt(life(best.metrics), 0)} charges to 80% capacity` : "Trip energy not delivered"}</div></div>
      <div class="vcard ref"><div class="k">CCCV 0.5C</div><div class="v">${fmt(half.metrics.durationMin, 1)} min</div><div class="s">600 charges to 80% capacity (reference)</div></div>
      ${gain}
    </div>

    <div class="charts">
      <article class="panel"><h4>Charge current</h4>${legend()}<div class="plot"><canvas id="c-i"></canvas></div></article>
      <article class="panel"><h4>Cell voltage</h4>${legend(true)}<div class="plot"><canvas id="c-v"></canvas></div></article>
      <article class="panel"><h4>Cell temperature</h4>${legend()}<div class="plot"><canvas id="c-t"></canvas></div></article>
      <article class="panel"><h4>State of charge</h4>${legend()}<div class="plot"><canvas id="c-s"></canvas></div></article>
    </div>

    <h3 class="sub-title">Pack life</h3>
    <p class="sub-lede">Capacity left after repeated charges like this one. CCCV 0.5C is the normal-usage reference: 80% capacity after 600 cycles.</p>
    <div class="charts">
      <article class="panel wide"><div class="legend"><span><i class="sw best"></i>Recommended</span><span><i class="sw ref"></i>CCCV 0.5C</span><span><i class="sw lim"></i>End of life (80%)</span></div><div class="plot tall"><canvas id="c-life"></canvas></div></article>
    </div>

    <h3 class="sub-title">Lifetime compared with normal usage</h3>
    <p class="sub-lede">Change in cycles to 80% capacity against CCCV 0.5C (600 cycles), for the best schedule of each type searched. Money saved is that change multiplied by the battery cost of ${rupees(req.cost)}.</p>
    <div class="charts">
      <article class="panel wide">${lifeBars(byFamily, best, life, req.cost)}</article>
    </div>
  </section>`;

  const b = series(best.trace, "Recommended", "#1f8a55");
  const r = series(half.trace, "CCCV 0.5C", "#d9692f", [6, 4]);
  const fx = (x) => `${x.toFixed(1)} min`;
  draw("c-i", { xLabel: "Time (min)", yLabel: "Current (A)", series: [b.amps, r.amps], yMin: 0, formatY: (y) => `${y.toFixed(2)} A`, formatX: fx });
  draw("c-v", { xLabel: "Time (min)", yLabel: "Voltage (V)", series: [b.volt, r.volt], guides: [{ y: V_MAX }], yMin: 3.6, yMax: 4.3, formatY: (y) => `${y.toFixed(3)} V`, formatX: fx });
  draw("c-t", { xLabel: "Time (min)", yLabel: "Temperature (°C)", series: [b.temp, r.temp], formatY: (y) => `${y.toFixed(2)} °C`, formatX: fx });
  draw("c-s", { xLabel: "Time (min)", yLabel: "State of charge (%)", series: [b.soc, r.soc], yMin: 0, yMax: 100, formatY: (y) => `${y.toFixed(1)}%`, formatX: fx });

  const nMax = Math.max(900, Math.ceil((1.2 * Math.max(600, life(best.metrics) || 0)) / 100) * 100);
  const cb = retentionCurve(best.metrics.qTotal, qHalf, nMax);
  const cr = retentionCurve(qHalf, qHalf, nMax);
  draw("c-life", {
    xLabel: "Cycles",
    yLabel: "Capacity remaining (%)",
    series: [
      { name: "Recommended", color: "#1f8a55", x: cb.cycles, y: cb.pct },
      { name: "CCCV 0.5C", color: "#d9692f", dash: [6, 4], x: cr.cycles, y: cr.pct },
    ],
    guides: [{ y: 80 }],
    yMin: 70,
    yMax: 100,
    formatY: (y) => `${y.toFixed(1)}%`,
    formatX: (x) => `${Math.round(x)} cycles`,
  });
}

async function run(evt) {
  if (evt) evt.preventDefault();
  const req = { km: Number($("km").value), minutes: Number($("minutes").value), cost: Math.max(0, Number($("cost").value) || 0) };
  if (!(req.km > 0) || !(req.minutes > 0)) {
    statusEl.textContent = "Enter a distance and a time above zero.";
    return;
  }
  const families = [...form.querySelectorAll('input[name="family"]:checked')].map((el) => el.value);
  if (!families.length) {
    statusEl.textContent = "Select at least one charging schedule to search.";
    return;
  }
  go.disabled = true;
  progress.hidden = false;
  bar.style.width = "3%";
  statusEl.textContent = "Charging the standard CCCV 0.5C, 1C and 2C schedules…";
  await new Promise((resolve) => setTimeout(resolve, 0));

  const v = vehicle();
  const d = tripDemand(req.km, twin.vNom, v.whkm, v.cells);
  // Standard charges run in the research session (up to 150 min), so each finishes.
  const base = sessionFor(d.energyFraction, Math.max(req.minutes, RESEARCH.baselineMaxMin));
  const baselines = [0.5, 1, 2].map((c) => {
    const params = baselineParams(c);
    const trace = rollout(FAMILIES.cccv, params, base, twin);
    return { name: `CCCV ${c}C`, family: "CCCV", familyId: "cccv", params, metrics: trace.metrics, end: trace.end, trace };
  });

  const session = sessionFor(d.energyFraction, req.minutes);
  const t0 = performance.now();
  const result = await planCharge(session, twin, { ...RESEARCH, families }, (frac) => {
    bar.style.width = `${Math.round(3 + frac * 97)}%`;
    statusEl.textContent = `Searching schedules… ${Math.round(frac * 100)}%`;
  });
  const win = result.top[0];
  const trace = rollout(FAMILIES[win.familyId], win.params, session, twin);
  const best = { ...win, trace, metrics: trace.metrics, end: trace.end };
  result.top[0] = { ...win, metrics: trace.metrics };

  statusEl.textContent = `Solved in ${((performance.now() - t0) / 1000).toFixed(1)} s`;
  progress.hidden = true;
  go.disabled = false;
  for (const key of Object.keys(charts)) delete charts[key];
  render(req, d, baselines, best, result.top, result.tested, result.byFamily);
}

function fail(err) {
  statusEl.textContent = "The plan stopped with an error. Details are below.";
  out.innerHTML = `<pre class="banner">${String(err && err.stack ? err.stack : err).replace(/</g, "&lt;")}</pre>`;
  go.disabled = false;
  progress.hidden = true;
}

// Vehicle type buttons set the cell count and efficiency. Editing either by hand clears the highlight.
const vehicleButtons = [...document.querySelectorAll(".presets button")];
function markVehicle() {
  for (const btn of vehicleButtons) {
    btn.classList.toggle("on", btn.dataset.cells === $("cells").value && btn.dataset.eff === $("eff").value);
  }
}
for (const btn of vehicleButtons) {
  btn.addEventListener("click", () => {
    $("cells").value = btn.dataset.cells;
    $("eff").value = btn.dataset.eff;
    markVehicle();
    updatePackNote();
    run().catch(fail);
  });
}
for (const id of ["cells", "eff"]) $(id).addEventListener("input", markVehicle);

for (const id of ["km", "eff", "cells"]) $(id).addEventListener("input", updatePackNote);
updatePackNote();

form.addEventListener("submit", (evt) => run(evt).catch(fail));
run().catch(fail);
