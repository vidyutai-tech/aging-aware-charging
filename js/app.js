/* Distance and time are the only inputs. Everything else follows the research
 * code (Final_Aging_aware_charging_opt): the RW9 twin, the four schedule types,
 * the study score, and the 600-charge lifetime anchor. Sources are in physics.js. */

import { mountChart } from "./charts.js";
import { FAMILIES, baselineParams, describeParams } from "./profiles.js";
import { SOC_START, SPACE, V_MAX, lifeToEighty, retentionCurve, tripDemand } from "./physics.js";
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
const sci = (n) => (n > 0 ? n.toExponential(2) : "–");

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

function within(m, minutes) {
  if (m.durationMin > minutes + 1e-9) return `Needs ${fmt(m.durationMin, 0)} min`;
  if (m.feasible) return "Yes";
  if (m.eNorm < 1 - 1e-3) return "Fell short";
  return "Went over 4.2 V";
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

function legend() {
  return '<div class="legend"><span><i class="sw best"></i>Recommended</span><span><i class="sw ref"></i>CCCV 0.5C</span></div>';
}

function render(req, d, baselines, best, tested) {
  const half = baselines[0];
  const qHalf = half.metrics.qTotal;
  const life = (m) => lifeToEighty(m.qTotal, qHalf).cycles;
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
    </div>

    <h3 class="sub-title">The charge</h3>
    <div class="charts">
      <article class="panel"><h4>Charge current</h4>${legend()}<div class="plot"><canvas id="c-i"></canvas></div></article>
      <article class="panel"><h4>Cell voltage</h4>${legend()}<div class="plot"><canvas id="c-v"></canvas></div></article>
      <article class="panel"><h4>Cell temperature</h4>${legend()}<div class="plot"><canvas id="c-t"></canvas></div></article>
      <article class="panel"><h4>State of charge</h4>${legend()}<div class="plot"><canvas id="c-s"></canvas></div></article>
    </div>

    <h3 class="sub-title">Capacity over repeated charges</h3>
    <p class="sub-lede">As in the research code: each charge adds its wear Q = Q<sub>cal</sub> + Q<sub>cyc</sub>, and CCCV 0.5C is set to 80% capacity at 600 charges.</p>
    <div class="charts">
      <article class="panel wide">${legend()}<div class="plot tall"><canvas id="c-life"></canvas></div></article>
    </div>

    <h3 class="sub-title">Standard charges and the recommendation</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>Charge</th><th class="n">Time (min)</th><th class="n">Peak °C</th><th class="n">Q<sub>cal</sub></th><th class="n">Q<sub>cyc</sub></th><th class="n">Q total</th><th class="n">Charges to 80%</th><th class="n">Study score</th><th>Within limits</th></tr></thead>
      <tbody>
        ${[...baselines, { ...best, name: "Recommended" }].map((r) => `<tr class="${r.name === "Recommended" ? "pick" : ""}"><td>${r.name}</td><td class="n">${fmt(r.metrics.durationMin)}</td><td class="n">${fmt(r.metrics.peakT)}</td><td class="n">${sci(r.metrics.qCalendar)}</td><td class="n">${sci(r.metrics.qCyclic)}</td><td class="n">${sci(r.metrics.qTotal)}</td><td class="n">${fmt(life(r.metrics), 0)}</td><td class="n">${fmt(r.metrics.reward, 1)}</td><td>${within(r.metrics, req.minutes)}</td></tr>`).join("")}
      </tbody>
    </table></div>
  </section>`;

  const b = series(best.trace, "Recommended", "#1f8a55");
  const r = series(half.trace, "CCCV 0.5C", "#d9692f", [6, 4]);
  const fx = (x) => `${x.toFixed(1)} min`;
  draw("c-i", { xLabel: "Time (min)", yLabel: "Current (A)", series: [b.amps, r.amps], yMin: 0, formatY: (y) => `${y.toFixed(2)} A`, formatX: fx });
  draw("c-v", { xLabel: "Time (min)", yLabel: "Voltage (V)", series: [b.volt, r.volt], guides: [{ y: V_MAX }], yMin: 3.6, yMax: 4.3, formatY: (y) => `${y.toFixed(3)} V`, formatX: fx });
  draw("c-t", { xLabel: "Time (min)", yLabel: "Temperature (°C)", series: [b.temp, r.temp], formatY: (y) => `${y.toFixed(2)} °C`, formatX: fx });
  draw("c-s", { xLabel: "Time (min)", yLabel: "State of charge (%)", series: [b.soc, r.soc], yMin: 0, yMax: 100, formatY: (y) => `${y.toFixed(1)}%`, formatX: fx });

  const nMax = Math.max(900, Math.ceil(1.2 * Math.max(600, life(best.metrics) || 0) / 100) * 100);
  const cb = retentionCurve(best.metrics.qTotal, qHalf, nMax);
  const cr = retentionCurve(qHalf, qHalf, nMax);
  draw("c-life", {
    xLabel: "Charges",
    yLabel: "Capacity remaining (%)",
    series: [
      { name: "Recommended", color: "#1f8a55", x: cb.cycles, y: cb.pct },
      { name: "CCCV 0.5C", color: "#d9692f", dash: [6, 4], x: cr.cycles, y: cr.pct },
    ],
    guides: [{ y: 80 }],
    yMin: 70,
    yMax: 100,
    formatY: (y) => `${y.toFixed(1)}%`,
    formatX: (x) => `${Math.round(x)} charges`,
  });
}

async function run(evt) {
  if (evt) evt.preventDefault();
  const req = { km: Number($("km").value), minutes: Number($("minutes").value) };
  if (!(req.km > 0) || !(req.minutes > 0)) {
    statusEl.textContent = "Enter a distance and a time above zero.";
    return;
  }
  go.disabled = true;
  progress.hidden = false;
  bar.style.width = "3%";
  statusEl.textContent = "Charging the standard CCCV 0.5C, 1C and 2C schedules…";
  await new Promise((resolve) => setTimeout(resolve, 0));

  const d = tripDemand(req.km, twin.vNom);
  // Standard charges run in the research session (up to 150 min), so each finishes.
  const base = sessionFor(d.energyFraction, Math.max(req.minutes, RESEARCH.baselineMaxMin));
  const baselines = [0.5, 1, 2].map((c) => {
    const params = baselineParams(c);
    const trace = rollout(FAMILIES.cccv, params, base, twin);
    return { name: `CCCV ${c}C`, family: "CCCV", familyId: "cccv", params, metrics: trace.metrics, end: trace.end, trace };
  });

  const session = sessionFor(d.energyFraction, req.minutes);
  const t0 = performance.now();
  const result = await planCharge(session, twin, RESEARCH, (frac) => {
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
  render(req, d, baselines, best, result.tested);
}

function fail(err) {
  statusEl.textContent = "The plan stopped with an error. Details are below.";
  out.innerHTML = `<pre class="banner">${String(err && err.stack ? err.stack : err).replace(/</g, "&lt;")}</pre>`;
  go.disabled = false;
  progress.hidden = true;
}

form.addEventListener("submit", (evt) => run(evt).catch(fail));
run().catch(fail);
