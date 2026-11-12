"""Python reference for the voltage-hold charge on the real RW9 twin (CCCV 0.5C, 1C, 2C).

    python twin/reference_hold.py twin 0.234 90 > ref.json   # args: twin folder, charge fraction, minutes
"""
import sys, json, numpy as np
sys.path.insert(0, sys.argv[1]); import rw9_twin as T
m = T.load_twin(); soc_g, ocv_g = T.ocv("RW9")
ocv = lambda s: float(np.interp(min(1, max(0, s)), soc_g, ocv_g))
s = np.linspace(.1, .9, 81); v_nom = float(np.mean(np.interp(s, soc_g, ocv_g)))
frac, budget = float(sys.argv[2]), float(sys.argv[3]); q_as = 2.2 * 3600
e_req = frac * q_as * v_nom; out = {}
for c in (0.5, 1.0, 2.0):
    sched = c * 2.2; v, t, prev, charge = ocv(.2), 24.0, 0.0, 0.0
    I, V, Tt = [], [], []; cv = None; end = "time"
    for d in range(int(budget * 2)):
        soc = .2 + charge / q_as
        if cv is not None:
            amps = min(sched, max(0, (4.2 - ocv(soc)) / cv))
            if amps < 0.05: end = "taper"; break
            _, tt = T.step_batch(m, [4.2], [t], [amps], [prev]); vv = np.full(30, 4.2); tt = tt[0]
        else:
            amps = sched; vv, tt = T.step_batch(m, [v], [t], [amps], [prev]); vv, tt = vv[0].copy(), tt[0].copy()
            k = np.flatnonzero(vv >= 4.2)
            if k.size:
                k = int(k[0]); cv = max(0.01, (4.2 - ocv(min(1, soc + sched * (k + 1) / q_as))) / sched)
                vv[k:] = 4.2; tt[k:] = tt[k]
        I += [amps] * 30; V += vv.tolist(); Tt += tt.tolist(); charge += amps * 30
        v, t, prev = float(vv[-1]), float(tt[-1]), amps
        e = np.cumsum(np.r_[0, 0.5 * (np.array(V[1:]) * I[1:] + np.array(V[:-1]) * I[:-1])])
        if e[-1] >= e_req - 1e-3:
            n = int(np.argmax(e >= e_req - 1e-3)) + 1; I, V, Tt = I[:n], V[:n], Tt[:n]; end = "energy"; break
    out[f"{c}C"] = {"min": len(I) / 60, "end": end, "v": V[::30], "t": Tt[::30], "i": I[::30]}
print(json.dumps(out))
