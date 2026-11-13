/* The page follows the research code (Final_Aging_aware_charging_opt): the RW9 twin, the four
 * schedule types, the study score, and the 600-charge lifetime anchor. Sources are in physics.js.
 * Every research value can be changed in the Advanced settings panel (settings.js). */

import { mountChart } from "./charts.js";
import { FAMILIES, baselineParams, describeParams } from "./profiles.js";
import { CELL_WH, N_CELLS, SOC_START, WH_PER_KM, lifeToEighty, tripDemand } from "./physics.js";
import { planCharge } from "./search.js";
import { buildAdvanced, readSettings } from "./settings.js";
import { rollout } from "./simulate.js";
import { loadTwin } from "./twin.js";

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

function vehicle() {
  const eff = Number($("eff").value); // kWh/km
  const whkm = eff > 0 ? eff * 1000 : 0;
  const cells = Math.round(Number($("cells").value));
  const cellWh = Number($("cellwh").value); // Wh per cell; blank or zero falls back to CELL_WH
  const soc0 = $("soc0").value === "" ? NaN : Number($("soc0").value) / 100; // starting charge; blank falls back to SOC_START
  return {
    whkm: whkm > 0 ? whkm : WH_PER_KM,
    cells: cells > 0 ? cells : N_CELLS,
    cellWh: cellWh > 0 ? cellWh : CELL_WH,
    socStart: Number.isFinite(soc0) ? Math.min(0.7, Math.max(0.05, soc0)) : SOC_START,
  };
}

function updatePackNote() {
  const v = vehicle();
  const d = tripDemand(Number($("km").value) || 0, twin.vNom, v.whkm, v.cells, v.cellWh, v.socStart);
  $("pack-note").textContent = `Pack: ${v.cells.toLocaleString("en-IN")} cells of ${fmt(d.fullWh, 2)} Wh, about ${fmt(d.packCapacityKwh, 1)} kWh. Each charge starts at ${Math.round(v.socStart * 100)}%. Between charges the car is parked at the average of its start and end charge.`;
}

function sessionFor(fraction, maxMin, socStart, cfg) {
  return {
    socStart,
    v0: twin.ocv(socStart), // starting cell voltage; equals the twin's measured 20% value at 20%
    t0: cfg.t0,
    energyFraction: fraction,
    maxMin,
    energyMode: true,
    vMax: cfg.vMax,
    vNom: twin.vNom,
    qAs: twin.qAs,
    weights: cfg.weights,
    deg: cfg.deg,
    space: { ...cfg.space, socStart },
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

function legend(limit = null) {
  return `<div class="legend"><span><i class="sw best"></i>Recommended</span><span><i class="sw ref"></i>CCCV 0.5C</span>${limit != null ? `<span><i class="sw lim"></i>${fmt(limit, 2)} V limit</span>` : ""}</div>`;
}

const rupees = (n) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/* Lifetime bars. For each schedule type: extra charges to 80% against CCCV 0.5C, the energy those
 * charges hold (extra charges × pack capacity), and the distance that energy drives (÷ efficiency).
 * Each row opens to show the calculation step by step. */
function lifeBars(rows, best, life, cost, ref, d) {
  const packKwh = d.packCapacityKwh;
  const eff = d.kwhPerKm;
  const signed = (x, digits) => `${x >= 0 ? "+" : "−"}${fmt(Math.abs(x), digits)}`;
  const items = rows.map((row) => {
    const pick = row.familyId === best.familyId;
    if (!row.feasible) return { name: row.family, pick, km: null };
    const cycles = life(row.metrics);
    const extra = cycles - ref;
    const kwh = extra * packKwh;
    return { name: row.family, pick, cycles, extra, pct: (cycles / ref - 1) * 100, kwh, km: kwh / eff };
  });
  const span = Math.max(1, ...items.map((it) => Math.abs(it.km ?? 0)));
  // Money saved = % change in cycles to 80% × battery cost (negative means extra cost).
  const money = (pct) => {
    const v = (pct / 100) * cost;
    return v >= 0 ? `<b>${rupees(v)}</b> saved` : `<b>${rupees(-v)}</b> extra cost`;
  };
  const steps = (it) => `<ol class="calc">
      <li><span>Charges to 80% capacity</span><span>CCCV 0.5C reference: <b>${fmt(ref, 0)}</b>. ${it.name}: <b>${fmt(it.cycles, 1)}</b> (${signed(it.pct, 1)}%)</span></li>
      <li><span>Extra charges</span><span>${fmt(it.cycles, 1)} − ${fmt(ref, 0)} = <b>${signed(it.extra, 1)}</b></span></li>
      <li><span>Pack capacity</span><span>${d.nCells.toLocaleString("en-IN")} cells × ${fmt(d.fullWh, 2)} Wh = <b>${fmt(packKwh, 2)} kWh</b></span></li>
      <li><span>Extra energy over the pack life</span><span>${signed(it.extra, 1)} × ${fmt(packKwh, 2)} kWh = <b>${signed(it.kwh, 1)} kWh</b></span></li>
      <li><span>Extra distance</span><span>${signed(it.kwh, 1)} kWh ÷ ${fmt(eff, 3)} kWh/km = <b>${signed(it.km, 0)} km</b></span></li>
    </ol>`;
  return `<div class="bars"><div class="bars-head"><span>Schedule</span><span></span><span>Extra km</span><span>Money saved</span></div>${items.map((it) => {
    if (it.km == null) return `<div class="bar-row"><span class="bar-name">${it.name}</span><span class="bar-track"></span><span class="bar-val muted">Did not finish in time</span><span class="bar-money">–</span></div>`;
    const w = (Math.abs(it.km) / span) * 50;
    const up = it.km >= 0;
    const side = up ? `left:50%;width:${w}%` : `left:${50 - w}%;width:${w}%`;
    return `<details class="bar-item${it.pick ? " pick" : ""}"><summary class="bar-row"><span class="bar-name">${it.name}${it.pick ? " (recommended)" : ""}</span><span class="bar-track"><i class="${up ? "up" : "down"}" style="${side}"></i></span><span class="bar-val ${up ? "up" : "down"}">${signed(it.km, 0)} km</span><span class="bar-money">${money(it.pct)}</span></summary>${steps(it)}</details>`;
  }).join("")}</div>`;
}

function render(req, d, baselines, best, top, tested, byFamily, cfg) {
  const half = baselines[0];
  const qHalf = half.metrics.qTotal;
  const life = (m) => lifeToEighty(m.qTotal, qHalf, cfg.lifeRef).cycles;
  const ref = fmt(cfg.lifeRef, 0);
  // Time saved against CCCV 0.5C, as a share of its charge time.
  const faster = best.metrics.feasible && half.metrics.durationMin > 0
    ? (1 - best.metrics.durationMin / half.metrics.durationMin) * 100
    : null;
  const gain = faster != null && faster >= 1 ? `<div class="vcard gain"><div class="k">Benefit</div><div class="v">${fmt(faster, 0)}%</div><div class="s">faster charging than CCCV 0.5C</div></div>` : "";
  const warn = [];
  if (d.capped) warn.push(`A charge from ${Math.round(d.socStart * 100)}% cannot hold this whole trip. The plan uses the largest charge that fits, enough for about ${fmt(d.maxKm, 0)} km.`);
  if (!best.metrics.feasible) warn.push(`No schedule delivered the trip energy within ${fmt(req.minutes, 0)} min and ${fmt(cfg.vMax, 2)} V. Allow more time or a shorter trip.`);

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
      <div class="vcard ref"><div class="k">CCCV 0.5C</div><div class="v">${fmt(half.metrics.durationMin, 1)} min</div><div class="s">${ref} charges to 80% capacity (reference)</div></div>
      ${gain}
    </div>

    <div class="charts">
      <article class="panel"><h4>Charge current</h4>${legend()}<div class="plot"><canvas id="c-i"></canvas></div></article>
      <article class="panel"><h4>Cell voltage</h4>${legend(cfg.vMax)}<div class="plot"><canvas id="c-v"></canvas></div></article>
      <article class="panel"><h4>Cell temperature</h4>${legend()}<div class="plot"><canvas id="c-t"></canvas></div></article>
      <article class="panel"><h4>State of charge</h4>${legend()}<div class="plot"><canvas id="c-s"></canvas></div></article>
    </div>

    <h3 class="sub-title">Lifetime compared with normal usage</h3>
    <p class="sub-lede">Extra distance the pack can drive before it reaches 80% capacity, against CCCV 0.5C (${ref} charges), for the best schedule of each type searched. Extra distance = extra charges × pack capacity ÷ efficiency. Money saved is the change in charges multiplied by the battery cost of ${rupees(req.cost)}. Open a row to see the calculation.</p>
    <div class="charts">
      <article class="panel wide">${lifeBars(byFamily, best, life, req.cost, cfg.lifeRef, d)}</article>
    </div>
  </section>`;

  const b = series(best.trace, "Recommended", "#1f8a55");
  const r = series(half.trace, "CCCV 0.5C", "#d9692f", [6, 4]);
  const fx = (x) => `${x.toFixed(1)} min`;
  draw("c-i", { xLabel: "Time (min)", yLabel: "Current (A)", series: [b.amps, r.amps], yMin: 0, formatY: (y) => `${y.toFixed(2)} A`, formatX: fx });
  draw("c-v", { xLabel: "Time (min)", yLabel: "Voltage (V)", series: [b.volt, r.volt], guides: [{ y: cfg.vMax }], yMin: 3.6, yMax: 4.3, formatY: (y) => `${y.toFixed(3)} V`, formatX: fx });
  draw("c-t", { xLabel: "Time (min)", yLabel: "Temperature (°C)", series: [b.temp, r.temp], formatY: (y) => `${y.toFixed(2)} °C`, formatX: fx });
  draw("c-s", { xLabel: "Time (min)", yLabel: "State of charge (%)", series: [b.soc, r.soc], yMin: 0, yMax: 100, formatY: (y) => `${y.toFixed(1)}%`, formatX: fx });
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
  const { cfg, errors } = readSettings();
  if (errors.length) {
    statusEl.textContent = `Advanced settings: ${errors.join(" ")}`;
    return;
  }
  go.disabled = true;
  progress.hidden = false;
  bar.style.width = "3%";
  statusEl.textContent = "Charging the standard CCCV 0.5C, 1C and 2C schedules…";
  await new Promise((resolve) => setTimeout(resolve, 0));

  const v = vehicle();
  const d = tripDemand(req.km, twin.vNom, v.whkm, v.cells, v.cellWh, v.socStart);
  // Standard charges run in the research session (150 min by default), so each finishes.
  const base = sessionFor(d.energyFraction, Math.max(req.minutes, cfg.baselineMaxMin), v.socStart, cfg);
  const baselines = [0.5, 1, 2].map((c) => {
    const params = baselineParams(c);
    const trace = rollout(FAMILIES.cccv, params, base, twin);
    return { name: `CCCV ${c}C`, family: "CCCV", familyId: "cccv", params, metrics: trace.metrics, end: trace.end, trace };
  });

  const session = sessionFor(d.energyFraction, req.minutes, v.socStart, cfg);
  const t0 = performance.now();
  const result = await planCharge(session, twin, { ...cfg.search, families }, (frac) => {
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
  render(req, d, baselines, best, result.top, result.tested, result.byFamily, cfg);
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

buildAdvanced($("adv-grid"), $("adv-count"), $("adv-reset"));

for (const id of ["km", "eff", "cells", "cellwh", "soc0"]) $(id).addEventListener("input", updatePackNote);
updatePackNote();

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
