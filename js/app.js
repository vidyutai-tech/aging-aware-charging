/* Distance and time are the only inputs. Everything else follows the research
 * code (Final_Aging_aware_charging_opt): the RW9 twin, the four schedule types,
 * the study score, and the 600-charge lifetime anchor. Sources are in physics.js. */

import { mountChart } from "./charts.js";
import { FAMILIES, baselineParams, describeParams } from "./profiles.js";
import { SOC_START, SPACE, V_MAX, lifeToEighty, tripDemand } from "./physics.js";
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
const rupees = (n) => `₹${Math.round(Math.abs(n)).toLocaleString("en-IN")}`;
const charts = {};

function fmt(n, digits = 1) {
  if (n == null || !Number.isFinite(n)) return "–";
  return n.toLocaleString("en-IN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
const VEHICLES = {
  two: { kwh: 0.03, cells: 360, cost: 80000 },
  three: { kwh: 0.08, cells: 950, cost: 250000 },
  compact: { kwh: 0.217, cells: 5100, cost: 500000 },
  large: { kwh: 0.236, cells: 7104, cost: 1500000 },
};

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
  const n = trace.current.length;
  const t = Array.from({ length: n }, (_, i) => i / 60);
  return {
    amps: { name, color, dash, x: t, y: trace.current.map((c) => Math.max(0, -c)) },
    volt: { name, color, dash, x: t, y: trace.voltage },
    temp: { name, color, dash, x: t, y: trace.temperature },
    soc: { name, color, dash, x: t, y: trace.metrics.soc.map((s) => s * 100) },
  };
}

function draw(id, spec) {
  if (!charts[id]) charts[id] = mountChart($(id));
  charts[id].set(spec);
}

function legend(limit = false) {
  return `<div class="legend"><span><i class="sw best"></i>Recommended</span><span><i class="sw ref"></i>CCCV 0.5C</span>${limit ? '<span><i class="sw lim"></i>4.2 V limit</span>' : ""}</div>`;
}

function render(req, d, baselines, best, tested, byFamily) {
  const half = baselines[0];
  const qHalf = half.metrics.qTotal;
  const life = (m) => lifeToEighty(m.qTotal, qHalf).cycles;
  const warn = [];
  if (d.capped) warn.push(`A charge from 20% cannot hold this whole trip. The plan uses the largest charge that fits, enough for about ${fmt(d.maxKm, 0)} km.`);
  if (!best.metrics.feasible) warn.push(`No schedule delivered the trip energy within ${fmt(req.minutes, 0)} min and 4.2 V. Allow more time or a shorter trip.`);

  const faster = half.metrics.durationMin > 0.5
    ? Math.round((1 - best.metrics.durationMin / half.metrics.durationMin) * 100)
    : 0;
  const benefit = Math.abs(faster) < 1
    ? "About the same time as CCCV 0.5C"
    : faster > 0
      ? `${faster}% faster charging than CCCV 0.5C`
      : `${-faster}% slower charging than CCCV 0.5C`;
  const bestLife = life(best.metrics);
  const refLife = life(half.metrics);
  const extra = Number.isFinite(bestLife) && Number.isFinite(refLife) ? bestLife - refLife : null;
  const lifePct = extra == null || !(refLife > 0) ? null : (100 * extra) / refLife;
  const lifeClass = lifePct == null || Math.abs(lifePct) < 0.05 ? "" : lifePct > 0 ? "gain" : "ref";
  const lifeValue = lifePct == null ? "—" : `${lifePct >= 0 ? "+" : "−"}${fmt(Math.abs(lifePct), 1)}%`;
  const saved = lifePct == null ? null : (lifePct / 100) * req.cost;
  const moneyNote = saved == null || !(req.cost > 0)
    ? ""
    : saved >= 0
      ? ` ${rupees(saved)} saved on the ${rupees(req.cost)} battery.`
      : ` ${rupees(-saved)} extra cost on the ${rupees(req.cost)} battery.`;
  const lifeNote = extra == null
    ? "Charges until capacity falls to 80%"
    : Math.abs(extra) < 0.5
      ? `Same life as CCCV 0.5C, to 80% capacity.${moneyNote}`
      : extra > 0
        ? `${fmt(extra, 0)} more charges before capacity falls to 80%.${moneyNote}`
        : `${fmt(-extra, 0)} fewer charges before capacity falls to 80%.${moneyNote}`;

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
      <div class="vcard gain"><div class="k">Faster charging</div><div class="v">${Math.abs(faster) < 1 ? "—" : `${Math.abs(faster)}%`}</div><div class="s">${benefit}</div></div>
      <div class="vcard ${lifeClass}"><div class="k">Longer life</div><div class="v">${lifeValue}</div><div class="s">${lifeNote}</div></div>
    </div>

    <h3 class="sub-title">Battery cost of that life</h3>
    <p class="sub-lede">For each schedule type, the change in charges to 80% capacity against CCCV 0.5C. Money saved is that percentage times the battery cost of ${rupees(req.cost)}.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Schedule</th><th class="n">Life vs CCCV 0.5C</th><th class="n">Money</th></tr></thead>
      <tbody>
        ${byFamily.map((row) => {
          const pct = row.feasible && Number.isFinite(life(row.metrics)) ? (life(row.metrics) / 600 - 1) * 100 : null;
          const cash = pct == null ? null : (pct / 100) * req.cost;
          const lifeCell = pct == null ? "Did not finish in time" : `${pct >= 0 ? "+" : "−"}${fmt(Math.abs(pct), 1)}%`;
          const moneyCell = cash == null ? "–" : cash >= 0 ? `${rupees(cash)} saved` : `${rupees(-cash)} extra`;
          return `<tr class="${row.familyId === best.familyId ? "pick" : ""}"><td>${row.family}${row.familyId === best.familyId ? " (recommended)" : ""}</td><td class="n">${lifeCell}</td><td class="n">${moneyCell}</td></tr>`;
        }).join("")}
      </tbody>
    </table></div>

    <div class="charts">
      <article class="panel"><h4>Charge current</h4>${legend()}<div class="plot"><canvas id="c-i"></canvas></div></article>
      <article class="panel"><h4>Cell voltage</h4>${legend(true)}<div class="plot"><canvas id="c-v"></canvas></div></article>
      <article class="panel"><h4>Cell temperature</h4>${legend()}<div class="plot"><canvas id="c-t"></canvas></div></article>
      <article class="panel"><h4>State of charge</h4>${legend()}<div class="plot"><canvas id="c-s"></canvas></div></article>
    </div>
  </section>`;

  const b = series(best.trace, "Recommended", "#1f8a55");
  const r = series(half.trace, "CCCV 0.5C", "#d9692f", [6, 4]);
  const fx = (x) => `${x.toFixed(1)} min`;
  draw("c-i", { xLabel: "Time (min)", yLabel: "Current (A)", series: [b.amps, r.amps], yMin: 0, formatY: (y) => `${y.toFixed(2)} A`, formatX: fx });
  draw("c-v", { xLabel: "Time (min)", yLabel: "Voltage (V)", series: [b.volt, r.volt], guides: [{ y: V_MAX }], yMin: 3.6, yMax: 4.3, formatY: (y) => `${y.toFixed(3)} V`, formatX: fx });
  draw("c-t", { xLabel: "Time (min)", yLabel: "Temperature (°C)", series: [b.temp, r.temp], formatY: (y) => `${y.toFixed(2)} °C`, formatX: fx });
  draw("c-s", { xLabel: "Time (min)", yLabel: "State of charge (%)", series: [b.soc, r.soc], yMin: 0, yMax: 100, formatY: (y) => `${y.toFixed(1)}%`, formatX: fx });
}

function readRequest() {
  const families = [...document.querySelectorAll('input[name="family"]:checked')].map((el) => el.value);
  return {
    km: Number($("km").value),
    minutes: Number($("minutes").value),
    whPerKm: Number($("kwhkm").value) * 1000,
    cells: Math.round(Number($("cells").value)),
    cost: Math.max(0, Number($("cost").value) || 0),
    families,
  };
}

function updatePackNote() {
  const req = readRequest();
  const fullWh = twin.vNom * twin.qAh;
  const packKwh = (fullWh * req.cells) / 1000;
  $("pack-note").textContent = `Pack: ${req.cells.toLocaleString("en-IN")} cells of ${fmt(fullWh, 2)} Wh, about ${fmt(packKwh, 1)} kWh. Each charge starts at 20%. Between charges the car is parked at the average of its start and end charge.`;
  for (const btn of document.querySelectorAll("#vehicles button")) {
    const v = VEHICLES[btn.dataset.vehicle];
    const match = Math.abs(Number($("kwhkm").value) - v.kwh) < 0.0005
      && Number($("cells").value) === v.cells
      && Number($("cost").value) === v.cost;
    btn.classList.toggle("on", match);
  }
}

async function run(evt) {
  if (evt) evt.preventDefault();
  const req = readRequest();
  if (!(req.km > 0) || !(req.minutes > 0)) {
    statusEl.textContent = "Enter a distance and a time above zero.";
    return;
  }
  if (!(req.whPerKm > 0) || !(req.cells > 0)) {
    statusEl.textContent = "Enter an efficiency and a cell count above zero.";
    return;
  }
  if (!req.families.length) {
    statusEl.textContent = "Choose at least one charging schedule.";
    return;
  }
  go.disabled = true;
  progress.hidden = false;
  bar.style.width = "3%";
  statusEl.textContent = "Charging the standard CCCV 0.5C, 1C and 2C schedules…";
  await new Promise((resolve) => setTimeout(resolve, 0));

  const d = tripDemand(req.km, twin.vNom, req.whPerKm, req.cells);
  // Standard charges run in the research session (up to 150 min), so each finishes.
  const base = sessionFor(d.energyFraction, Math.max(req.minutes, RESEARCH.baselineMaxMin));
  const baselines = [0.5, 1, 2].map((c) => {
    const params = baselineParams(c);
    const trace = rollout(FAMILIES.cccv, params, base, twin);
    return { name: `CCCV ${c}C`, family: "CCCV", familyId: "cccv", params, metrics: trace.metrics, end: trace.end, trace };
  });

  const session = sessionFor(d.energyFraction, req.minutes);
  const t0 = performance.now();
  const result = await planCharge(session, twin, { ...RESEARCH, families: req.families }, (frac) => {
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
  render(req, d, baselines, best, result.tested, result.byFamily);
}

function fail(err) {
  statusEl.textContent = "The plan stopped with an error. Details are below.";
  out.innerHTML = `<pre class="banner">${String(err && err.stack ? err.stack : err).replace(/</g, "&lt;")}</pre>`;
  go.disabled = false;
  progress.hidden = true;
}

form.addEventListener("submit", (evt) => run(evt).catch(fail));
for (const btn of document.querySelectorAll("#vehicles button")) {
  btn.addEventListener("click", () => {
    const v = VEHICLES[btn.dataset.vehicle];
    $("kwhkm").value = String(v.kwh);
    $("cells").value = String(v.cells);
    $("cost").value = String(v.cost);
    updatePackNote();
  });
}
for (const id of ["kwhkm", "cells", "cost"]) $(id).addEventListener("input", updatePackNote);
updatePackNote();
run().catch(fail);
