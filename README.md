# KE SNE Screening Prototype

Offline-first functional screening prototype for **dyslexia and dyscalculia indicators** in Kenyan primary schools (CBC framework). Built from a Google Stitch design export.

> **Screening only. Not a clinical or medical diagnosis.** Formal assessment and placement are decided by the sub-county Educational Assessment and Resource Centre (EARC). The score bands in the code are **provisional placeholders**, not validated norms. Have an SNE specialist confirm them before any real-world use.

**Live demo:** _add your GitHub Pages link here after deploying_

## What works today
| Screen | Status |
|---|---|
| Dashboard, learner details, run management | Working |
| Test 1: Subitizing & dot comparison, with `performance.now()` reaction timing | Working |
| Test 7: Digit span, spoken via the Web Speech API (English / Kiswahili) | Working |
| IEP editor, EARC referral toggle, PDF export (IEP document and EARC slip) | Working |
| Tests 2-6 (symbol mapping, arithmetic, nonword decoding, phoneme deletion, RAN) | Not built yet |

"Load sample results" on the dashboard fills all 7 tests so you can preview the report; sample PDFs are watermarked.

## Run locally
```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production build in dist/
```
Requires Node 18+.

## Structure
```
public/            static assets (favicon)
src/App.jsx        the whole app: storage, speech, timing, PDF export, 4 screens
src/schema.js      Dexie schema and helpers (same code is inlined in App.jsx)
src/main.jsx       React entry point
src/index.css      global reset
```
`schema.js` is a standalone copy of section 1 of `App.jsx`. To use it as a module, delete that section from `App.jsx` and add `import { db, upsertLearner, ... } from "./schema";`.

## Data and privacy
- Everything is stored **on the device** in IndexedDB (Dexie). No server calls, no analytics.
- Use a pseudonymous learner code (e.g. `STU-NBO-0001`), **not** a child's full name.
- "Delete this learner's data" on the dashboard removes that learner's records from the device.
- Review the Kenya Data Protection Act, 2019 and your school and county requirements before collecting real learner data.

## Known limitations
- Kiswahili speech needs a `sw` voice installed on the device. Otherwise the app falls back to English and shows a warning.
- Digit spacing in speech depends on the device voice, so timing is approximate.
- No service worker yet. Data works offline, but loading the app itself offline needs one (for example `vite-plugin-pwa`).
- The EARC slip is a school-generated summary, **not** the official MoE form. Match it to your sub-county template.

## Deploy to GitHub Pages
1. Push this repo to GitHub.
2. Repo **Settings > Pages > Build and deployment > Source: GitHub Actions**.
3. Add `.github/workflows/deploy.yml` (Vite's static-deploy template), or run `npm run build` and publish `dist/` to a `gh-pages` branch.
