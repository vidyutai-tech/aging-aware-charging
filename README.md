# Aging-aware EV charging on a battery digital twin

A static web page that plans one electric-vehicle charge. You enter the trip, the time you have at the charger and how the car is used. The page searches charging schedules on the RW9 battery digital twin and shows what each one does to pack life. Everything runs in the browser, so GitHub Pages can host it as is.

## Publish on GitHub Pages

1. Create a new repository and push this folder as its root.
2. In the repository, open **Settings → Pages** and set **Source** to **GitHub Actions**.
3. The workflow in `.github/workflows/pages.yml` publishes the site on every push to `main` or `master`, or when you run it by hand.

The site address is `https://<user>.github.io/<repository>/`. The workflow publishes only `index.html`, `css/`, `js/`, `data/` and `assets/`. The `twin/` folder, including the checkpoint, stays in the repository but is not served.

To try it locally, run `python3 -m http.server` in this folder and open `http://localhost:8000`. Opening `index.html` straight from disk does not work, because browsers block modules on `file://`.

## Logos

`assets/logo-left.svg` and `assets/logo-right.svg` are placeholders. Replace them with your files. If your logos are PNG, change the two `src` attributes at the top of `index.html`.

## Layout

| Path | What it is |
|------|------|
| `index.html`, `css/app.css` | Page and theme |
| `js/twin.js` | RW9 twin in the browser: interpolates the exported 30-second step table |
| `js/simulate.js` | Closed-loop charge: schedule, 4.2 V limit, energy target |
| `js/profiles.js` | CCCV, two-step, three-step and pulsed schedules (as in `optimization.py`) |
| `js/physics.js` | Trip energy and the study's session score (`score_session`, unchanged) |
| `js/life.js` | Pack life: calendar plus cyclic aging over many charges |
| `js/search.js` | Gaussian-process and random search |
| `data/pack.js` | RW9 twin step table, exported from the checkpoint |
| `twin/checkpoints/twin_source_RW9.pt` | Frozen RW9 twin |
| `twin/rw9_twin.py` | Loads the checkpoint and predicts voltage and temperature |
| `twin/export_pack.py` | Rebuilds `data/pack.js` from the checkpoint |
| `twin/reference_hold.py`, `twin/browser_baselines.mjs` | Run the same charges in Python on the real twin and in the browser code, to compare |

## The RW9 twin

The checkpoint holds a transformer decoder with 2.0 M parameters and a 150-sample window. It takes the cell's age, its starting voltage and temperature, and a current sequence (negative while charging). It returns voltage and temperature every second. To print a charge, run:

```bash
pip install -r twin/requirements.txt
python twin/rw9_twin.py --amps 1.1 --minutes 30 --csv rw9_0p5C.csv
```

The starting voltage comes from the RW9 open-circuit voltage curve: 3.737 V at 20% state of charge.

The browser does not run the network. It interpolates a table of 30-second responses that `export_pack.py` computes from the checkpoint. The table covers 22 starting voltages (0.025 V apart above 4.05 V), 7 temperatures and 19 × 19 present and previous currents. Against the real twin, the CCCV 0.5C, 1C and 2C charges at 10%, 23% and 55% charge added agree to within 0.05 min on time, about 1–2 mV on mean voltage and 0.5 °C on temperature. Check it with:

```bash
python twin/reference_hold.py twin 0.55 90 > ref.json
node twin/browser_baselines.mjs . 0.55 90 > js.json
```

Rebuilding the table takes about 5 minutes on a laptop CPU: `cd twin && python export_pack.py`.

## What follows the study code exactly, and what is new

These are the same as in `Final_Aging_aware_charging_opt` (checked line by line, with matching numbers):

- the degradation coefficients in `config.DEGRADATION`
- the session score `R = 1000 (2.5 ΔSOC − 7500 Q − 1.1 t_h^0.55)`, with the same penalties
- the four schedule families, their bounds and clipping, and the energy-target stop
- the 4.616 A current cap and the 4.2 V limit

Two changes make the results realistic. Both can be switched back under **Advanced settings**.

**1. Pack life on real time (calendar plus cyclic).** The study ranks charges by one session's wear index. It then sets CCCV 0.5C to 80% capacity at 600 charges. That has two problems:

- The calendar law grows with √t, so evaluating it from t = 0 for a 27-minute session gives about 1e-4 per charge, roughly 100 times the cyclic wear. Charging time then dominates "wear", which is why the fastest charge used to win.
- A linear projection of a single charge, like *cycles = 20 / q*, is wrong when the exponents are not 1 (z_cal = 0.5, z_cyc = 1.4). For 0.5C, 20% divided by the session index (9.7e-5) gives about 2,070 charges. The cyclic part alone (8.9e-7) gives about 226,000. The first number is too pessimistic and the second is far too optimistic.

The page now accumulates both laws over the life of the pack, with the equivalent-time method described in `optimization.py`. One cycle is the charge itself, second by second from the twin, plus the time until the next charge. During that time the car is parked at the average of its start and end charge, at the parking temperature. The page finds the number of charges at which calendar plus cyclic loss reaches 20%, and reports it in charges and in years. By default the search picks the schedule with the longest life that delivers the trip energy in the time you have.

**2. A realistic voltage hold.** In the study rule, each 30-second step that touches 4.2 V lowers the current by 0.25 A, and the current never rises again. On the twin this pins the current at the floor for a long time. For example, 1C to 75% took 88 min, longer than 0.5C. It also makes results jump with millivolt-level differences. In the hold mode, the twin runs until it first reaches the limit. An effective resistance is then read off the twin, R = (4.2 V − OCV(SOC)) / I. After that the current is min(schedule, (4.2 V − OCV(SOC)) / R), so it tapers as the cell fills. The twin still gives the temperature.

## Assumptions to keep in mind

- One 2.2 Ah cell stands for the whole pack (6,831 cells by default). Cell-to-cell spread is not modelled.
- Each charge starts at 20%, the starting point of the study and of the twin's initial voltage.
- Cycle aging counts charge ampere-hours, as in the study's fit. Discharge while driving adds calendar time only.
- The cyclic coefficients come from NASA RW cells cycled with random currents, and they rise steeply with C-rate. Lives at 2C are short.
- The twin starts every charge at 24 °C. Its temperature range is 18–30 °C, so the parking temperature affects only calendar aging.
- The twin predicts slow charges cooling the cell from 24 °C. That is the learned behaviour of the RW9 data, not a heat model.
