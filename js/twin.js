/** RW9 digital twin in the browser: interpolate the exported 30-second step table. */

function b64ToI16(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

function bracket(axis, x) {
  const n = axis.length;
  if (x <= axis[0]) return [0, 0, 0];
  if (x >= axis[n - 1]) return [n - 1, n - 1, 0];
  let hi = 1;
  while (hi < n && axis[hi] < x) hi += 1;
  const lo = hi - 1;
  const span = axis[hi] - axis[lo];
  return [lo, hi, span > 0 ? (x - axis[lo]) / span : 0];
}

function interp(xs, ys, x) {
  const [lo, hi, f] = bracket(xs, x);
  return ys[lo] + f * (ys[hi] - ys[lo]);
}

export function loadTwin(pack) {
  const { v_axis: vAxis, t_axis: tAxis, i_axis: iAxis, step_s: step } = pack;
  const nt = tAxis.length;
  const ni = iAxis.length;
  const volt = b64ToI16(pack.volt_b64);
  const temp = b64ToI16(pack.temp_b64);
  const { v_off: vOff, v_scale: vScale, t_scale: tScale } = pack.quant;

  function sample(iv, it, ia, ip, outV, outT, weight) {
    if (weight === 0) return;
    const base = (((iv * nt + it) * ni + ia) * ni + ip) * step;
    for (let k = 0; k < step; k++) {
      outV[k] += weight * (volt[base + k] / vScale + vOff);
      outT[k] += weight * (temp[base + k] / tScale);
    }
  }

  const pairs = ([a, b, f]) => (f === 0 ? [[a, 1]] : [[a, 1 - f], [b, f]]);

  /** Voltage and temperature for 30 one-second samples at a charge current (A, positive). */
  function stepResponse(v0, t0, amps, prevAmps) {
    const outV = new Float64Array(step);
    const outT = new Float64Array(step);
    for (const [iv, wv] of pairs(bracket(vAxis, v0))) {
      for (const [it, wt] of pairs(bracket(tAxis, t0))) {
        for (const [ia, wa] of pairs(bracket(iAxis, Math.abs(amps)))) {
          for (const [ip, wp] of pairs(bracket(iAxis, Math.abs(prevAmps)))) {
            sample(iv, it, ia, ip, outV, outT, wv * wt * wa * wp);
          }
        }
      }
    }
    return { v: outV, t: outT };
  }

  return {
    vNom: pack.v_nom,
    v0: pack.v0_soc20,
    t0: pack.t0_c,
    qAh: pack.q_ah,
    qAs: pack.q_ah * 3600,
    step,
    stepResponse,
    /** Open-circuit voltage of RW9 at a state of charge (0-1). */
    ocv: (soc) => interp(pack.ocv_soc, pack.ocv_v, Math.min(1, Math.max(0, soc))),
  };
}
