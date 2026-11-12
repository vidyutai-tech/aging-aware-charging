// Same three charges through the browser code: node twin/browser_baselines.mjs . 0.234 90 > js.json
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = path.resolve(process.argv[2] || ".");
const raw = fs.readFileSync(path.join(root, "data/pack.js"), "utf8");
globalThis.PACK_DATA = JSON.parse(raw.slice(raw.indexOf("=") + 1).trim().replace(/;$/, ""));
const mod = (f) => import(pathToFileURL(path.join(root, "js", f)).href);
const { loadTwin } = await mod("twin.js");
const { FAMILIES, baselineParams } = await mod("profiles.js");
const { rollout } = await mod("simulate.js");
const { SPACE } = await mod("physics.js");
const twin = loadTwin(globalThis.PACK_DATA);
const session = { socStart: 0.2, energyFraction: Number(process.argv[3] || 0.234), maxMin: Number(process.argv[4] || 90),
  energyMode: true, vMax: 4.2, vNom: twin.vNom, qAs: twin.qAs, space: SPACE, cvMode: "hold", objective: "life",
  weights: { wSoc: 2.5, wLoss: 7500, wTime: 1.1, zTime: 0.55 }, usage: { hoursBetween: 24, parkC: 25, eolPct: 80 } };
const out = {};
for (const c of [0.5, 1, 2]) {
  const r = rollout(FAMILIES.cccv, baselineParams(c), session, twin);
  const every = (a) => a.filter((_, i) => i % 30 === 0);
  out[`${c.toFixed(1)}C`] = { min: r.metrics.durationMin, charges: r.metrics.life.charges, v: every(r.voltage), t: every(r.temperature), i: every(r.current).map((x) => -x) };
}
console.log(JSON.stringify(out));
