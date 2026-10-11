[README.md](https://github.com/user-attachments/files/33301274/README.md)
# KE SNE Screening Prototype

Offline-first functional screening prototype for **dyslexia and dyscalculia indicators** in Kenyan primary schools (CBC framework). Built from a Google Stitch design export.

> **Screening only. Not a clinical or medical diagnosis.** Formal assessment and placement are decided by the sub-county Educational Assessment and Resource Centre (EARC). The score bands in the code are **provisional placeholders**, not validated norms. Have an SNE specialist confirm them before any real-world use.

**Live demo:** _add your GitHub Pages link here after deploying_

## What works today
All seven screening tasks, the IEP editor and PDF export work. Everything is stored on-device.

| # | Test | How it is scored |
|---|---|---|
| 1 | Subitizing & dot comparison (1-6 dots) | % correct, `performance.now()` reaction times |
| 2 | Symbol-quantity mapping (numerals 1-20, dots and ten-frames) | % correct, reaction times |
| 3 | Single-digit arithmetic fluency | % correct, reaction times |
| 4 | Nonsense word decoding | **Teacher marks** each word the learner reads aloud |
| 5 | Phoneme / syllable deletion, read aloud (Web Speech API) | % correct, reaction times |
| 6 | Rapid automatised naming (colours, numbers, objects) | **Teacher times** each grid and counts errors |
| 7 | Digit span (forward), spoken digits | Longest correct span / 6 |

"Load sample results" on the dashboard fills all 7 tests so you can preview the report; sample PDFs are watermarked.

### Content that needs expert review before real use
- **Score bands** (75+ on track, 50-74 monitor, below 50 priority) are placeholders, not validated norms.
- **RAN benchmarks** (`RAN_BENCH`) are placeholder seconds for a 30-item grid. Replace with norms for the learner's age or grade.
- **Kiswahili item sets** (`PHONEME_SETS.sw`, `NONWORDS.sw`) and the Kiswahili prompts should be reviewed by a native-speaker teacher. Check that no pseudo-word is a real word locally.
- Tests 4 and 6 are teacher-administered because offline speech recognition is not reliable.

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
