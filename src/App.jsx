/* CBC SNE Screener: single-file App.jsx
 * Dependencies (CodeSandbox / StackBlitz install these automatically from the imports):
 *   react, react-dom, dexie, jspdf, @fontsource/lexend, @fontsource/opendyslexic
 * Sections: 1 Dexie schema (identical to schema.js) | 2 constants | 3 speech | 4 timing | 5 PDF | 6 UI
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Dexie from "dexie";
import { jsPDF } from "jspdf";
import "@fontsource/lexend/400.css";
import "@fontsource/lexend/600.css";
import "@fontsource/lexend/700.css";
import "@fontsource/opendyslexic/400.css";

/* ==========================================================================
   1. OFFLINE STORAGE (Dexie / IndexedDB). Same code as schema.js.
   ========================================================================== */
// schema.js — offline storage for the CBC SNE Screener (Dexie.js / IndexedDB)
//
// Install:  npm i dexie
// Use in App.jsx:  import { db, upsertLearner, startSession, ... } from "./schema";
//
// Privacy: everything stays on the device. Store a pseudonymous learner CODE
// (e.g. STU-NBO-0001), not the child's full name.


const db = new Dexie("cbc_sne_screener");

// Only indexed fields are listed; other properties are stored too.
db.version(1).stores({
  learners: "++id, &code, grade, updatedAt",
  sessions: "++id, learnerId, startedAt, status",
  trials: "++id, sessionId, testKey, [sessionId+testKey]",
  testResults: "key, sessionId, testKey", // key = `${sessionId}:${testKey}`
  ieps: "sessionId, learnerId, updatedAt", // one IEP draft per screening run
  settings: "key",
});

const now = () => Date.now();

// ---- learners --------------------------------------------------------------
async function upsertLearner({ code, grade, age, school, assessor }) {
  const patch = { grade, age, school, assessor, updatedAt: now() };
  const existing = await db.learners.where("code").equals(code).first();
  if (existing) {
    await db.learners.update(existing.id, patch);
    return { ...existing, ...patch };
  }
  const rec = { code, ...patch, createdAt: now() };
  rec.id = await db.learners.add(rec);
  return rec;
}

async function latestLearner() {
  return (await db.learners.orderBy("updatedAt").last()) || null;
}

// ---- sessions (a "screening run") -----------------------------------------
async function startSession(learnerId, { sample = false } = {}) {
  const runs = await db.sessions.where("learnerId").equals(learnerId).count();
  const rec = { learnerId, startedAt: now(), status: "in_progress", run: runs + 1, sample };
  rec.id = await db.sessions.add(rec);
  return rec;
}

async function latestSession(learnerId) {
  const all = await db.sessions.where("learnerId").equals(learnerId).toArray();
  return all.sort((a, b) => b.startedAt - a.startedAt)[0] || null;
}

// ---- trials + per-test summary --------------------------------------------
async function saveTrials(sessionId, testKey, trials) {
  await db.transaction("rw", db.trials, async () => {
    await db.trials.where("[sessionId+testKey]").equals([sessionId, testKey]).delete();
    await db.trials.bulkAdd(trials.map((t) => ({ ...t, sessionId, testKey })));
  });
}

async function saveTestResult(sessionId, testKey, summary) {
  await db.testResults.put({ key: `${sessionId}:${testKey}`, sessionId, testKey, ...summary, savedAt: now() });
}

async function getResults(sessionId) {
  const rows = await db.testResults.where("sessionId").equals(sessionId).toArray();
  return Object.fromEntries(rows.map((r) => [r.testKey, r]));
}

// ---- IEP draft -------------------------------------------------------------
async function getIep(sessionId) {
  return (await db.ieps.get(sessionId)) || null;
}

async function saveIep(sessionId, learnerId, data) {
  await db.ieps.put({ ...data, sessionId, learnerId, updatedAt: now() });
}

// ---- settings --------------------------------------------------------------
async function getSetting(key, fallback) {
  const row = await db.settings.get(key);
  return row ? row.value : fallback;
}
async function setSetting(key, value) {
  await db.settings.put({ key, value });
}

// ---- deletion (data-protection friendly) ----------------------------------
async function deleteLearnerData(learnerId) {
  await db.transaction("rw", db.learners, db.sessions, db.trials, db.testResults, db.ieps, async () => {
    const sessionIds = (await db.sessions.where("learnerId").equals(learnerId).toArray()).map((s) => s.id);
    for (const id of sessionIds) {
      await db.trials.where("sessionId").equals(id).delete();
      await db.testResults.where("sessionId").equals(id).delete();
      await db.ieps.delete(id);
    }
    await db.sessions.where("learnerId").equals(learnerId).delete();
    await db.learners.delete(learnerId);
  });
}

/* ==========================================================================
   2. CONSTANTS, SCORING, HELPERS
   ========================================================================== */

// SCORING BANDS ARE PLACEHOLDERS. They are NOT validated norms. Have your SNE
// specialist / EARC officer confirm or replace them before real-world use.
const BANDS = [
  { min: 75, label: "On track", tone: "good" },
  { min: 50, label: "Monitor", tone: "mid" },
  { min: 0, label: "Priority support", tone: "care" },
];
const bandFor = (score) => BANDS.find((b) => score >= b.min);
const MAX_SPAN = 6; // digit-span ceiling used for the 0-100 score

const TESTS = [
  { n: 1, key: "subitizing", domain: "dyscalculia", built: true, title: "Subitizing & Dot Comparison", desc: "Rapid quantity recognition without counting (1-6 dots), with reaction times." },
  { n: 2, key: "mapping", domain: "dyscalculia", title: "Symbol-Quantity Mapping", desc: "Match numerals 1-20 to dot arrangements and ten-frames." },
  { n: 3, key: "arithmetic", domain: "dyscalculia", title: "Single-Digit Arithmetic Fluency", desc: "Addition and subtraction response speed." },
  { n: 4, key: "nonword", domain: "dyslexia", title: "Nonsense Word Decoding", desc: "Decode unfamiliar pseudo-words." },
  { n: 5, key: "phoneme", domain: "dyslexia", title: "Phoneme Deletion & Manipulation", desc: "Sound segmentation and onset extraction." },
  { n: 6, key: "ran", domain: "dyslexia", title: "Rapid Automatized Naming (RAN)", desc: "Visual-verbal retrieval speed." },
  { n: 7, key: "digitspan", domain: "memory", built: true, title: "Digit Span Memory", desc: "Forward digit span using spoken English / Kiswahili digits." },
];
const DOMAINS = [
  { key: "dyscalculia", label: "Dyscalculia indicators", short: "Numeracy" },
  { key: "dyslexia", label: "Dyslexia indicators", short: "Literacy" },
  { key: "memory", label: "Working memory", short: "Memory" },
];

// Sample scores so you can preview the full report/PDF. Clearly labelled SAMPLE everywhere.
const SAMPLE = {
  subitizing: { score: 92, note: "Sample: 11/12 correct, median 1450 ms" },
  mapping: { score: 85, note: "Sample data" },
  arithmetic: { score: 90, note: "Sample data" },
  nonword: { score: 46, note: "Sample data" },
  phoneme: { score: 52, note: "Sample data" },
  ran: { score: 88, note: "Sample data" },
  digitspan: { score: 50, note: "Sample: longest forward span 3 digits" },
};

const DEFAULT_ACCOMMODATIONS = [
  { id: "a1", cat: "literacy", comp: "Learning to Learn", title: "Colour-overlay reading rulers & sans-serif handouts", note: "Provide a green tint overlay sheet for English passage exercises and enlarge line spacing.", on: false },
  { id: "a2", cat: "numeracy", comp: "Self-Efficacy", title: "Maths strengths peer mentorship", note: "Seat the learner with a peer study group during numeracy activities to build confidence.", on: false },
  { id: "a3", cat: "literacy", comp: "Digital Literacy", title: "Oral & speech-to-text response alternatives", note: "Accept verbal answers during formative assessments to reduce decoding fatigue.", on: false },
  { id: "a4", cat: "sensory", comp: "Critical Thinking", title: "Multi-step visual task anchor cards", note: "Break 3-step instructions into individual visual cue cards clipped to the learner's desk.", on: false },
  { id: "a5", cat: "sensory", comp: "Self-Efficacy", title: "+25% extended time & sensory rest breaks", note: "Grant a 15 min quiet rest interval after 30 mins of sustained reading during end-of-term evaluations.", on: false },
];
const CAT_LABEL = { literacy: "Literacy & Phonics", numeracy: "Numeracy Strengths", sensory: "Sensory & Exam" };
const COMPETENCIES = ["Learning to Learn", "Self-Efficacy", "Communication & Collaboration", "Critical Thinking", "Digital Literacy"];

const emptyIep = (sample = false) => ({
  accommodations: DEFAULT_ACCOMMODATIONS.map((a) => ({ ...a, on: sample })),
  summary: sample ? "SAMPLE: Strong number sense; delays in phonetic decoding and phoneme manipulation. Short digit span. Recommend peer-supported numeracy and oral response alternatives." : "",
  earcReferral: sample,
});

const DIGIT_WORDS = {
  en: ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"],
  sw: ["sifuri", "moja", "mbili", "tatu", "nne", "tano", "sita", "saba", "nane", "tisa"],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const fmtDate = (ts) => new Date(ts).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// Combine per-test results into per-domain indicators.
function computeProfile(results) {
  const rows = TESTS.map((t) => {
    const r = results[t.key];
    return { ...t, score: r ? r.score : null, note: r ? r.note || "" : "", band: r ? bandFor(r.score) : null };
  });
  const groups = DOMAINS.map((d) => {
    const inGroup = rows.filter((r) => r.domain === d.key);
    const done = inGroup.filter((r) => r.score !== null);
    const avg = done.length ? done.reduce((s, r) => s + r.score, 0) / done.length : null;
    const band = avg === null ? null : bandFor(avg);
    const text =
      band === null
        ? "Not yet assessed"
        : band.tone === "good"
        ? "Low support indicator"
        : band.tone === "mid"
        ? "Some support indicators"
        : "Higher support indicator";
    return { ...d, avg, band, text, done: done.length, total: inGroup.length };
  });
  return { rows, groups };
}

/* ==========================================================================
   3. SPEECH  (Web Speech API: window.speechSynthesis)
   ========================================================================== */

function useSpeech(lang, enabled) {
  const supported =
    typeof window !== "undefined" && "speechSynthesis" in window && typeof window.SpeechSynthesisUtterance !== "undefined";
  const [voices, setVoices] = useState([]);
  const utterRef = useRef(null); // keep a reference: Chrome can garbage-collect utterances mid-speech
  const runRef = useRef(0);

  useEffect(() => {
    if (!supported) return undefined;
    const synth = window.speechSynthesis;
    const load = () => setVoices(synth.getVoices());
    load();
    synth.addEventListener?.("voiceschanged", load);
    return () => synth.removeEventListener?.("voiceschanged", load);
  }, [supported]);

  const swVoice = voices.find((v) => /^sw/i.test(v.lang));
  const enVoice =
    voices.find((v) => /^en[-_]KE/i.test(v.lang)) ||
    voices.find((v) => /^en[-_](GB|ZA|NG|US|AU)/i.test(v.lang)) ||
    voices.find((v) => /^en/i.test(v.lang));
  // If the voice list is known and has no Kiswahili voice, fall back to English rather than mispronounce.
  const swMissing = lang === "sw" && voices.length > 0 && !swVoice;
  const effLang = lang === "sw" && !swMissing ? "sw" : "en";

  const stop = useCallback(() => {
    runRef.current += 1;
    if (supported) window.speechSynthesis.cancel();
  }, [supported]);

  // Speak a string; resolves true when finished, false if unsupported/disabled/error.
  const speak = useCallback(
    (text, { rate = 0.85 } = {}) =>
      new Promise((resolve) => {
        if (!supported || !enabled || !text) return resolve(false);
        try {
          const synth = window.speechSynthesis;
          synth.cancel();
          const u = new window.SpeechSynthesisUtterance(text);
          const voice = effLang === "sw" ? swVoice : enVoice;
          if (voice) u.voice = voice;
          u.lang = voice ? voice.lang : effLang === "sw" ? "sw-KE" : "en-GB";
          u.rate = rate;
          u.pitch = 1;
          let done = false;
          const finish = (ok) => {
            if (!done) {
              done = true;
              resolve(ok);
            }
          };
          u.onend = () => finish(true);
          u.onerror = () => finish(false);
          utterRef.current = u;
          synth.speak(u);
          setTimeout(() => finish(false), 9000); // safety net
        } catch {
          resolve(false);
        }
      }),
    [supported, enabled, effLang, swVoice, enVoice]
  );

  // Pick the text for the active language: speakText({ en: "...", sw: "..." })
  const say = useCallback((t, opts) => speak(effLang === "sw" ? t.sw : t.en, opts), [speak, effLang]);

  return { supported, enabled, effLang, swMissing, speak, say, stop, runRef };
}

/* ==========================================================================
   4. TIMING  (performance.now() / event.timeStamp)
   ========================================================================== */

// Reaction time = pointer event time - stimulus onset (both on the performance.now() clock).
// event.timeStamp is when the browser received the tap, so it excludes React/JS queue delay.
function reactionMs(e, t0) {
  let rt = e && typeof e.timeStamp === "number" ? e.timeStamp - t0 : NaN;
  if (!(rt >= 0 && rt < 600000)) rt = performance.now() - t0; // old browsers use epoch timestamps
  return Math.round(rt * 10) / 10;
}

// Waits for the stimulus to be painted, then stamps onset. Returns a cancel function.
function stampOnset(setT0) {
  let r2 = 0;
  const r1 = requestAnimationFrame(() => {
    r2 = requestAnimationFrame(() => setT0(performance.now()));
  });
  return () => {
    cancelAnimationFrame(r1);
    cancelAnimationFrame(r2);
  };
}

/* ==========================================================================
   5. PDF EXPORT  (pure client-side, jsPDF; no server calls)
   ========================================================================== */

const PC = {
  primary: [90, 96, 22],
  ink: [28, 40, 24],
  mute: [90, 92, 76],
  line: [200, 199, 181],
  soft: [233, 248, 223],
  bar: [216, 231, 206],
  care: [154, 103, 99],
  warn: [138, 118, 40],
};
// jsPDF's built-in fonts only cover Latin-1; replace anything else so text never garbles.
const pdfSafe = (s) =>
  String(s ?? "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, "...")
    .replace(/[–—]/g, "-")
    .replace(/[•·]/g, "-")
    .replace(/ /g, " ")
    .replace(/[^\x20-\x7E\n¡-ÿ]/g, "?");

function createWriter(doc) {
  const W = 210, H = 297, M = 16, CW = W - 2 * M, BOTTOM = H - 18;
  const w = { y: M, M, CW, W };
  const color = (c, kind = "text") =>
    kind === "text" ? doc.setTextColor(...c) : kind === "fill" ? doc.setFillColor(...c) : doc.setDrawColor(...c);
  w.ensure = (h) => {
    if (w.y + h > BOTTOM) {
      doc.addPage();
      w.y = M;
    }
  };
  w.header = (title, subtitle) => {
    color(PC.primary, "fill");
    doc.rect(0, 0, W, 30, "F");
    color([255, 255, 255]);
    doc.setFont("helvetica", "bold").setFontSize(17);
    doc.text(pdfSafe(title), M, 14);
    doc.setFont("helvetica", "normal").setFontSize(9.5);
    doc.text(pdfSafe(subtitle), M, 21.5);
    w.y = 38;
  };
  w.h2 = (text) => {
    w.y += 3;
    w.ensure(14);
    doc.setFont("helvetica", "bold").setFontSize(11.5);
    color(PC.primary);
    doc.text(pdfSafe(text).toUpperCase(), M, w.y + 4);
    color(PC.line, "draw");
    doc.setLineWidth(0.4);
    doc.line(M, w.y + 6.2, W - M, w.y + 6.2);
    w.y += 11;
  };
  w.p = (text, { size = 10, bold = false, c = PC.ink, indent = 0, gap = 1.5 } = {}) => {
    doc.setFont("helvetica", bold ? "bold" : "normal").setFontSize(size);
    color(c);
    const lh = size * 0.3528 * 1.4;
    for (const line of doc.splitTextToSize(pdfSafe(text), CW - indent)) {
      w.ensure(lh);
      doc.text(line, M + indent, w.y + lh * 0.78);
      w.y += lh;
    }
    w.y += gap;
  };
  w.box = (text, { fill = PC.soft, c = PC.ink, size = 9.5 } = {}) => {
    doc.setFont("helvetica", "normal").setFontSize(size);
    const lines = doc.splitTextToSize(pdfSafe(text), CW - 8);
    const lh = size * 0.3528 * 1.4;
    const h = lines.length * lh + 6;
    w.ensure(h + 3);
    color(fill, "fill");
    doc.roundedRect(M, w.y, CW, h, 2, 2, "F");
    color(c);
    lines.forEach((l, i) => doc.text(l, M + 4, w.y + 4.2 + i * lh + lh * 0.55));
    w.y += h + 4;
  };
  w.kv = (pairs) => {
    // two-column grid of "Label: value"
    const colW = CW / 2;
    for (let i = 0; i < pairs.length; i += 2) {
      w.ensure(11);
      [pairs[i], pairs[i + 1]].forEach((pair, j) => {
        if (!pair) return;
        const x = M + j * colW;
        doc.setFont("helvetica", "normal").setFontSize(8);
        color(PC.mute);
        doc.text(pdfSafe(pair[0]).toUpperCase(), x, w.y + 3);
        doc.setFont("helvetica", "bold").setFontSize(10.5);
        color(PC.ink);
        doc.text(doc.splitTextToSize(pdfSafe(pair[1] || "-"), colW - 4)[0], x, w.y + 8);
      });
      w.y += 11.5;
    }
    w.y += 1;
  };
  w.scoreRow = (row) => {
    w.ensure(13);
    doc.setFont("helvetica", "bold").setFontSize(10);
    color(PC.ink);
    doc.text(pdfSafe(`${row.n}. ${row.title}`), M, w.y + 4);
    doc.setFont("helvetica", "normal").setFontSize(8.5);
    color(PC.mute);
    doc.text(pdfSafe(row.score === null ? "Not administered in this run" : row.note || ""), M, w.y + 8.6);
    const bx = M + 108, bw = 34;
    color(PC.bar, "fill");
    doc.roundedRect(bx, w.y + 2, bw, 3.4, 1.2, 1.2, "F");
    if (row.score !== null) {
      color(row.band.tone === "care" ? PC.care : PC.primary, "fill");
      doc.roundedRect(bx, w.y + 2, Math.max(1.5, (bw * row.score) / 100), 3.4, 1.2, 1.2, "F");
      doc.setFont("helvetica", "bold").setFontSize(9);
      color(PC.ink);
      doc.text(`${Math.round(row.score)}%`, bx + bw + 3, w.y + 5);
      doc.setFont("helvetica", "normal").setFontSize(8);
      color(PC.mute);
      doc.text(pdfSafe(row.band.label), bx, w.y + 9);
    }
    w.y += 13;
  };
  w.sign = (labels) => {
    w.ensure(26);
    w.y += 8;
    const n = labels.length, gap = 8, sw = (CW - gap * (n - 1)) / n;
    labels.forEach((l, i) => {
      const x = M + i * (sw + gap);
      color(PC.ink, "draw");
      doc.setLineWidth(0.3);
      doc.line(x, w.y, x + sw, w.y);
      doc.setFont("helvetica", "normal").setFontSize(8.5);
      color(PC.mute);
      doc.text(pdfSafe(l), x, w.y + 4.5);
      doc.text("Date: ____ / ____ / ______", x, w.y + 9.5);
    });
    w.y += 12;
  };
  return w;
}

function finishPdf(doc, { sample, footer }) {
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setDrawColor(...PC.line).setLineWidth(0.3);
    doc.line(16, 281, 194, 281);
    doc.setFont("helvetica", "normal").setFontSize(7.5).setTextColor(...PC.mute);
    doc.text(pdfSafe(footer), 16, 286);
    doc.text(`Page ${i} of ${pages}`, 194, 286, { align: "right" });
    if (sample) {
      doc.saveGraphicsState();
      doc.setGState(new doc.GState({ opacity: 0.1 }));
      doc.setFont("helvetica", "bold").setFontSize(64).setTextColor(...PC.care);
      doc.text("SAMPLE DATA", 105, 160, { align: "center", angle: 40 });
      doc.restoreGraphicsState();
    }
  }
}

const NOTICE =
  "Screening only. This is not a clinical or medical diagnosis. Formal assessment and placement are decided by the sub-county Educational Assessment and Resource Centre (EARC).";

function pdfContext(ctx) {
  const { learner, session, results, iep } = ctx;
  const profile = computeProfile(results);
  return {
    learner,
    profile,
    iep,
    sample: !!session?.sample,
    dateStr: fmtDate(Date.now()),
    run: session?.run || 1,
    active: iep.accommodations.filter((a) => a.on),
  };
}

function learnerPairs(c) {
  return [
    ["Learner code", c.learner.code],
    ["Grade / Age", `Grade ${c.learner.grade || "-"} / ${c.learner.age || "-"} yrs`],
    ["School", c.learner.school],
    ["Assessor", c.learner.assessor],
    ["Screening date", c.dateStr],
    ["Screening run", c.sample ? "Sample run" : `Baseline run #${c.run}`],
  ];
}

// CBC IEP document (A4, multi-page)
function buildIepPdf(ctx) {
  const c = pdfContext(ctx);
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const w = createWriter(doc);
  w.header("CBC Individualised Education Programme (IEP)", "Functional Learning Profile - Kenya Competency-Based Curriculum (primary)");
  w.kv(learnerPairs(c));
  w.box(NOTICE, { fill: [241, 180, 175] });

  w.h2("Functional screening results");
  c.profile.rows.forEach((r) => w.scoreRow(r));
  w.p("Bands are screening indicators using provisional cut-offs (75+ on track, 50-74 monitor, below 50 priority support).", { size: 8, c: PC.mute });

  w.h2("Support indicators by domain");
  c.profile.groups.forEach((g) => {
    w.p(`${g.label}: ${g.text}${g.done ? ` (${g.done} of ${g.total} tasks)` : ""}`, { bold: true, gap: 1 });
  });

  w.h2(`Accommodations selected (${c.active.length})`);
  if (!c.active.length) w.p("No accommodations selected yet.", { c: PC.mute });
  c.active.forEach((a, i) => {
    w.p(`${i + 1}. ${a.title}`, { bold: true, gap: 0.5 });
    w.p(`${CAT_LABEL[a.cat] || a.cat}  |  CBC core competency: ${a.comp}`, { size: 8.5, c: PC.mute, indent: 4, gap: 0.5 });
    w.p(a.note, { indent: 4, gap: 3 });
  });

  w.h2("Teacher summary notes");
  w.p(c.iep.summary || "(none recorded)", { c: c.iep.summary ? PC.ink : PC.mute });
  w.p(`EARC stage 2 referral: ${c.iep.earcReferral ? "Recommended - see referral slip" : "Not selected / deferred"}`, { bold: true });

  w.sign(["Class / SNE teacher", "Headteacher", "Parent / Guardian"]);
  finishPdf(doc, { sample: c.sample, footer: `CBC IEP | ${c.learner.code} | Generated on-device ${c.dateStr}. Confidential learner record.` });
  return doc;
}

// EARC referral slip (A4, normally one page)
function buildEarcPdf(ctx) {
  const c = pdfContext(ctx);
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const w = createWriter(doc);
  w.header("EARC Referral Slip", "School-generated referral summary for the sub-county Educational Assessment and Resource Centre");
  w.kv(learnerPairs(c));
  w.box(NOTICE, { fill: [241, 180, 175] });

  w.h2("Referral status");
  w.p(c.iep.earcReferral ? "Referral for stage 2 diagnostic assessment is RECOMMENDED by the school." : "Referral not yet selected by the school (deferred).", { bold: true });

  w.h2("Reason for referral / teacher observations");
  w.p(c.iep.summary || "(none recorded)", { c: c.iep.summary ? PC.ink : PC.mute });

  w.h2("Screening findings");
  c.profile.groups.forEach((g) => {
    w.p(`${g.label}: ${g.text}`, { bold: true, gap: 0.5 });
  });
  c.profile.rows
    .filter((r) => r.score !== null)
    .forEach((r) => w.p(`${r.n}. ${r.title}: ${Math.round(r.score)}% (${r.band.label}) ${r.note ? "- " + r.note : ""}`, { size: 8.5, indent: 4, gap: 0 }));
  if (c.profile.rows.some((r) => r.score === null)) w.p("Tasks not yet administered are not included.", { size: 8.5, c: PC.mute });

  w.h2("Support already in place at school");
  if (!c.active.length) w.p("None recorded.", { c: PC.mute });
  if (c.active.length) w.p(c.active.map((a) => a.title).join("; ") + ".", { size: 9.5 });

  w.h2("Parent / guardian consent to share this screening summary with EARC");
  w.ensure(14);
  doc.setDrawColor(...PC.ink).setLineWidth(0.3);
  doc.rect(w.M, w.y + 1, 4.5, 4.5);
  doc.rect(w.M + 28, w.y + 1, 4.5, 4.5);
  doc.setFont("helvetica", "normal").setFontSize(10).setTextColor(...PC.ink);
  doc.text("Yes", w.M + 7, w.y + 5);
  doc.text("No", w.M + 35, w.y + 5);
  w.y += 10;

  w.sign(["Class / SNE teacher", "Headteacher", "Parent / Guardian"]);
  finishPdf(doc, { sample: c.sample, footer: `EARC referral slip | ${c.learner.code} | Generated on-device ${c.dateStr}. Confidential learner record.` });
  return doc;
}

const safeName = (s) => String(s || "learner").replace(/[^A-Za-z0-9_-]+/g, "_");

function exportPdf(kind, ctx) {
  const doc = kind === "iep" ? buildIepPdf(ctx) : buildEarcPdf(ctx);
  const date = new Date().toISOString().slice(0, 10);
  const name = `${kind === "iep" ? "CBC_IEP" : "EARC_Referral_Slip"}_${safeName(ctx.learner.code)}_${date}.pdf`;
  doc.save(name); // instant client-side download; no network involved
  return name;
}

/* ==========================================================================
   6. UI
   ========================================================================== */

const CSS = `
:root{--bg:#effee4;--card:#e4f3d9;--card-hi:#deedd4;--card-lo:#e9f8df;--ink:#131f0f;--mute:#47483a;--primary:#5a6016;--primary-dk:#454b00;--on-primary:#fff;
--accent:#dbeb8c;--accent-dk:#bfce73;--rose:#ffdad7;--rose-dk:#9a6763;--line:#c8c7b5;--stim:#f8fbee}
.sne{font-family:'Lexend',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--ink);min-height:100vh;
 letter-spacing:.03em;line-height:1.6;font-size:16px;padding:0 0 110px}
.sne.dys{font-family:'OpenDyslexic','Lexend',system-ui,sans-serif;letter-spacing:.06em;line-height:1.8}
.sne *{box-sizing:border-box}
.sne button{font:inherit;letter-spacing:inherit;color:inherit;cursor:pointer;border:0;touch-action:manipulation}
.sne button:focus-visible,.sne input:focus-visible,.sne textarea:focus-visible,.sne select:focus-visible{outline:3px solid var(--primary);outline-offset:2px}
.hdr{position:sticky;top:0;z-index:20;background:rgba(239,254,228,.94);backdrop-filter:blur(8px);padding:8px 16px;box-shadow:0 2px 12px rgba(28,40,24,.07)}
.row{display:flex;align-items:center;gap:8px}.between{justify-content:space-between}.wrap{flex-wrap:wrap}.grow{flex:1;min-width:0}
.brand{font-weight:700;font-size:18px;line-height:1.3}.sub{font-size:12px;color:var(--mute);line-height:1.3}
.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:999px;background:var(--accent);font-size:12px;font-weight:600;min-height:32px}
.pill.off{background:var(--rose)}.pill.btn{background:var(--card-hi);box-shadow:0 2px 0 var(--line);min-height:40px}.pill.btn[aria-pressed=true]{background:var(--accent-dk)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--primary)}
main{padding:16px;max-width:760px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
.card{background:var(--card);border-radius:16px;padding:20px;box-shadow:0 4px 0 #d8e7ce,0 10px 20px -4px rgba(28,40,24,.08)}
.card.lo{background:var(--card-lo);box-shadow:0 2px 0 var(--line)}
.card.stage{background:var(--accent);box-shadow:0 4px 0 var(--accent-dk)}
h1,h2,h3,h4{margin:0;line-height:1.35}h1{font-size:22px}h2{font-size:18px}h3{font-size:17px}h4{font-size:15px}
p{margin:0}.small{font-size:13px;color:var(--mute);line-height:1.5}.tag{font-size:11px;font-weight:700;text-transform:uppercase;color:var(--primary);letter-spacing:.06em}
.btn{min-height:56px;padding:12px 20px;border-radius:16px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;gap:8px;
 background:var(--primary);color:var(--on-primary);box-shadow:0 4px 0 var(--primary-dk);transition:transform .05s}
.btn:active{transform:translateY(4px);box-shadow:none}.btn.sec{background:var(--accent-dk);color:var(--ink);box-shadow:0 4px 0 #9cae4f}
.btn.rose{background:var(--rose);color:#33110f;box-shadow:0 4px 0 var(--rose-dk)}.btn.ghost{background:var(--card-hi);color:var(--ink);box-shadow:0 3px 0 var(--line)}
.btn[disabled]{opacity:.5;pointer-events:none}.btn.block{width:100%}
.bar{height:12px;border-radius:99px;background:#d8e7ce;overflow:hidden}.bar>i{display:block;height:100%;background:var(--primary);border-radius:99px;transition:width .3s}.bar.care>i{background:var(--rose-dk)}
.test{display:flex;flex-direction:column;gap:8px}.test.locked{opacity:.65;background:var(--card-hi)}
.num{width:32px;height:32px;border-radius:50%;background:var(--primary);color:#fff;display:grid;place-items:center;font-weight:700;flex:none}.locked .num{background:#d8e7ce;color:var(--mute)}
.stage-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;width:100%;max-width:420px;margin:0 auto}
.box{background:var(--stim);border-radius:16px;height:150px;display:grid;place-items:center;box-shadow:0 3px 0 var(--line);border:3px solid transparent;width:100%}
.box:active{transform:translateY(3px)}.box:focus-visible{border-color:var(--primary)}
.field{display:flex;flex-direction:column;gap:4px}.field label{font-size:13px;font-weight:600}
.field input,.field select,.field textarea{font:inherit;letter-spacing:inherit;padding:10px 12px;border-radius:12px;border:2px solid rgba(28,40,24,.25);background:var(--stim);min-height:48px;width:100%;color:var(--ink)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.slots{display:flex;gap:10px;justify-content:center}.slot{min-width:56px;height:68px;border-radius:14px;background:var(--stim);display:grid;place-items:center;font-size:32px;font-weight:700;color:var(--primary);box-shadow:0 3px 0 #d8e7ce;padding:0 6px}
.slot.act{background:#d8e7ce;outline:3px solid var(--primary)}
.keypad{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;max-width:320px;margin:0 auto;width:100%}
.key{height:64px;border-radius:16px;background:var(--stim);font-size:28px;font-weight:700;box-shadow:0 4px 0 var(--line)}.key:active{transform:translateY(4px);box-shadow:none}
.wave{display:flex;gap:4px;align-items:center;justify-content:center;height:40px}.wave i{width:6px;height:12px;border-radius:3px;background:var(--primary);animation:wv 0.9s ease-in-out infinite}
.wave i:nth-child(2n){animation-delay:.15s}.wave i:nth-child(3n){animation-delay:.3s}@keyframes wv{50%{height:36px}}
@media (prefers-reduced-motion:reduce){.wave i{animation:none;height:24px}}
.nav{position:fixed;bottom:0;left:0;right:0;z-index:30;background:rgba(239,254,228,.97);box-shadow:0 -3px 16px rgba(28,40,24,.1);display:flex;justify-content:space-around;padding:6px 8px calc(6px + env(safe-area-inset-bottom,0px))}
.nav button{background:none;min-width:64px;min-height:56px;border-radius:14px;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:11px;font-weight:600;color:var(--mute);gap:2px}
.nav button[aria-current=page]{background:rgba(219,235,140,.7);color:var(--primary);font-weight:700;box-shadow:0 2px 0 var(--primary)}.nav .ic{font-size:22px;line-height:1}
.toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);background:#273423;color:#e6f5dc;padding:12px 20px;border-radius:14px;z-index:50;max-width:92vw;font-size:14px}
.switch{width:52px;height:32px;border-radius:99px;background:#d8e7ce;position:relative;flex:none;padding:0}.switch::after{content:"";position:absolute;top:4px;left:4px;width:24px;height:24px;border-radius:50%;background:#787868;transition:transform .15s}
.switch[aria-checked=true]{background:var(--accent-dk)}.switch[aria-checked=true]::after{transform:translateX(20px);background:var(--primary)}
.acc{background:var(--card-lo);border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:8px}.acc.off{opacity:.6}
.warn{background:var(--rose);color:#33110f;border-radius:12px;padding:10px 14px;font-size:13px}
.chips{display:flex;gap:8px;flex-wrap:wrap}.chip{padding:8px 14px;border-radius:12px;background:var(--card-hi);font-size:13px;min-height:44px;font-weight:600}.chip[aria-pressed=true]{background:var(--primary);color:#fff}
.big{font-size:56px;font-weight:700;color:var(--primary);line-height:1}
`;

function Toast({ msg }) {
  return msg ? <div className="toast" role="status">{msg}</div> : null;
}

function Bar({ score, tone }) {
  return (
    <div className={`bar ${tone === "care" ? "care" : ""}`} role="img" aria-label={score === null ? "not assessed" : `${Math.round(score)} percent`}>
      <i style={{ width: `${score === null ? 0 : Math.max(2, score)}%` }} />
    </div>
  );
}

/* ---------- Screen 1: Dashboard ---------- */
function Dashboard({ learner, session, results, onSaveLearner, onLaunch, onNewRun, onSample, onDelete, speech }) {
  const [form, setForm] = useState(learner);
  const [open, setOpen] = useState(false);
  useEffect(() => setForm(learner), [learner]);
  const done = TESTS.filter((t) => results[t.key]).length;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const next = TESTS.find((t) => t.built && !results[t.key]) || TESTS.find((t) => t.built);

  return (
    <>
      <section className="card">
        <div className="row between wrap" style={{ marginBottom: 12 }}>
          <span className="pill">{learner.code} · Grade {learner.grade} · Age {learner.age}</span>
          <span className="pill">{session?.sample ? "Sample run" : `Baseline run #${session?.run || 1}`}</span>
        </div>
        <span className="tag">CBC SNE Functional Battery</span>
        <h1 style={{ margin: "4px 0 6px" }}>Full Functional Screener</h1>
        <p className="small">Play-based tasks mapped to CBC foundation strands. Non-punitive: no answer is ever marked wrong on screen.</p>
        <div style={{ marginTop: 14 }}>
          <div className="row between small"><b>Progress</b><b style={{ color: "var(--primary)" }}>{done} of 7 completed</b></div>
          <div className="bar" style={{ marginTop: 6 }}><i style={{ width: `${(done / 7) * 100}%` }} /></div>
        </div>
        {session?.sample && <p className="warn" style={{ marginTop: 12 }}>Sample data is loaded for previewing the report. It is not a real learner.</p>}
      </section>

      <section className="card lo">
        <button className="btn ghost block" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Hide learner details" : "Edit learner details"}
        </button>
        {open && (
          <form
            style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}
            onSubmit={(e) => {
              e.preventDefault();
              onSaveLearner({ ...form, code: (form.code || "").trim() || "STU-NBO-0001" });
              setOpen(false);
            }}
          >
            <div className="grid2">
              <div className="field"><label htmlFor="lc">Learner code (no full names)</label><input id="lc" value={form.code} onChange={set("code")} /></div>
              <div className="field"><label htmlFor="lg">Grade</label><input id="lg" inputMode="numeric" value={form.grade} onChange={set("grade")} /></div>
              <div className="field"><label htmlFor="la">Age</label><input id="la" inputMode="numeric" value={form.age} onChange={set("age")} /></div>
              <div className="field"><label htmlFor="ls">School</label><input id="ls" value={form.school} onChange={set("school")} /></div>
            </div>
            <div className="field"><label htmlFor="lt">Assessor (teacher)</label><input id="lt" value={form.assessor} onChange={set("assessor")} /></div>
            <p className="small">Entering a different code switches to (or creates) that learner. Data stays on this device.</p>
            <button className="btn" type="submit">Save learner</button>
          </form>
        )}
      </section>

      <h2>Screening sequence</h2>
      {TESTS.map((t) => {
        const r = results[t.key];
        const locked = !t.built;
        return (
          <article key={t.key} className={`card test ${locked ? "locked" : ""}`}>
            <div className="row between">
              <div className="row"><span className="num">{t.n}</span><span className="pill off" style={{ background: t.domain === "memory" ? "var(--accent)" : "var(--rose)" }}>{DOMAINS.find((d) => d.key === t.domain).short}</span></div>
              <span className="pill">{r ? "Done ✓" : locked ? "Not in this build" : "Ready"}</span>
            </div>
            <h3>{t.title}</h3>
            <p className="small">{t.desc}</p>
            {!locked && (
              <button className="btn block" onClick={() => onLaunch(t.key)}>
                {r ? "Repeat this test" : "Launch"} →
              </button>
            )}
          </article>
        );
      })}

      <div className="card lo small">
        Results build an initial functional profile for the school IEP coordinator and EARC officer. Data is stored only on this device (IndexedDB).
      </div>
      <button className="btn block" onClick={() => onLaunch(next.key)}>Start next test: {next.title} →</button>
      <div className="row wrap">
        <button className="btn ghost grow" onClick={onNewRun}>Start new screening run</button>
        <button className="btn ghost grow" onClick={onSample}>Load sample results (preview)</button>
        <button className="btn rose grow" onClick={onDelete}>Delete this learner's data</button>
      </div>
    </>
  );
}

/* ---------- Screen 2: Subitizing & dot comparison (reaction timing) ---------- */
function scatterDots(n, size = 112, r = 8, gap = 6) {
  const pts = [];
  let guard = 0;
  while (pts.length < n && guard++ < 4000) {
    const x = r + Math.random() * (size - 2 * r);
    const y = r + Math.random() * (size - 2 * r);
    if (pts.every((p) => Math.hypot(p.x - x, p.y - y) > 2 * r + gap)) pts.push({ x, y });
  }
  return pts;
}

function makeSubitizingItems() {
  const pairs = [];
  for (let a = 1; a <= 6; a++) for (let b = a + 1; b <= 6; b++) pairs.push([a, b]);
  const practicePairs = [[1, 5], [2, 6]];
  const rest = shuffle(pairs.filter(([a, b]) => !practicePairs.some(([x, y]) => x === a && y === b))).slice(0, 12);
  const mk = ([lo, hi], practice) => {
    const largerLeft = Math.random() < 0.5;
    const left = largerLeft ? hi : lo, right = largerLeft ? lo : hi;
    return { practice, left, right, larger: largerLeft ? "A" : "B", dotsA: scatterDots(left), dotsB: scatterDots(right) };
  };
  return [...practicePairs.map((p) => mk(p, true)), ...rest.map((p) => mk(p, false))];
}

const OBS = ["Finger pointing", "Verbal counting", "Subitizing gaze"];

function SubitizingTest({ speech, onComplete, onExit }) {
  const [items, setItems] = useState(null);
  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState("intro"); // intro | blank | stim | feedback | paused | done
  const [t0, setT0] = useState(null);
  const [summary, setSummary] = useState(null);
  const [obs, setObs] = useState({});
  const trialsRef = useRef([]);
  const resumeRef = useRef("repeat");
  const [liveMs, setLiveMs] = useState(null);

  const prompt = { en: "Which box has more dots? Tap it as fast as you can.", sw: "Ni kisanduku gani kina nukta nyingi zaidi? Kigusa haraka." };

  const start = () => {
    trialsRef.current = [];
    setItems(makeSubitizingItems());
    setIdx(0);
    setT0(null);
    setPhase("blank");
  };

  useEffect(() => {
    if (phase === "blank") {
      setT0(null);
      const id = setTimeout(() => setPhase("stim"), 450);
      return () => clearTimeout(id);
    }
    if (phase === "stim") return stampOnset(setT0); // t0 set only after the dots are painted
    if (phase === "feedback") {
      const id = setTimeout(() => advance(), 650);
      return () => clearTimeout(id);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, idx]);

  const advance = () => {
    if (idx + 1 < items.length) {
      setIdx(idx + 1);
      setPhase("blank");
    } else finish();
  };

  const answer = (choice, e) => {
    if (phase !== "stim" || t0 === null) return; // ignore taps before the stimulus is on screen
    const rt = reactionMs(e, t0);
    const item = items[idx];
    const correct = choice === item.larger;
    trialsRef.current.push({
      itemIndex: idx, practice: item.practice, left: item.left, right: item.right, choice, correct,
      rtMs: rt, anticipatory: rt < 200, at: Date.now(),
    });
    setLiveMs(rt);
    setPhase("feedback");
  };

  const finish = () => {
    const scored = trialsRef.current.filter((t) => !t.practice);
    const correct = scored.filter((t) => t.correct);
    const valid = correct.filter((t) => !t.anticipatory).map((t) => t.rtMs);
    const s = {
      score: scored.length ? Math.round((correct.length / scored.length) * 100) : 0,
      correct: correct.length, total: scored.length,
      medianRtMs: median(valid) && Math.round(median(valid)), meanRtMs: mean(valid) && Math.round(mean(valid)),
      fastestMs: valid.length ? Math.round(Math.min(...valid)) : null, slowestMs: valid.length ? Math.round(Math.max(...valid)) : null,
      anticipatory: scored.filter((t) => t.anticipatory).length, observations: Object.keys(obs).filter((k) => obs[k]),
    };
    s.note = `${s.correct}/${s.total} correct${s.medianRtMs ? `, median ${s.medianRtMs} ms` : ""}`;
    setSummary(s);
    setPhase("done");
    onComplete("subitizing", s, trialsRef.current);
  };

  const pause = () => {
    resumeRef.current = phase === "feedback" ? "next" : "repeat";
    setPhase("paused");
  };
  const resume = () => (resumeRef.current === "next" ? advance() : setPhase("blank")); // timing of an interrupted item restarts

  const item = items && items[idx];
  const scoredIdx = item ? items.slice(0, idx + 1).filter((i) => !i.practice).length : 0;
  const pct = items ? Math.round((idx / items.length) * 100) : 0;
  const Dots = ({ pts }) => (
    <svg viewBox="0 0 112 112" width="112" height="112" aria-hidden="true">{pts.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r="8" fill="#131f0f" />)}</svg>
  );

  if (phase === "intro")
    return (
      <section className="card stage" style={{ textAlign: "center" }}>
        <span className="tag">Test 1 of 7 · Number concept</span>
        <h1 style={{ margin: "8px 0" }}>Subitizing & Dot Comparison</h1>
        <p>Ni kisanduku gani kina nukta NYINGI zaidi?</p>
        <p className="small" style={{ marginBottom: 16 }}>Which box has MORE dots? 2 practice items, then 12 scored items. Tap quickly, don't count one by one.</p>
        <div className="row wrap" style={{ justifyContent: "center" }}>
          <button className="btn rose" onClick={() => speech.say(prompt)}>🔊 Sikiliza (Listen)</button>
          <button className="btn" onClick={() => { speech.say(prompt); start(); }}>Anza (Start) →</button>
        </div>
        {speech.swMissing && <p className="warn" style={{ marginTop: 12 }}>No Kiswahili voice found on this device: audio is read in English. On-screen Kiswahili text is unaffected.</p>}
      </section>
    );

  if (phase === "done")
    return (
      <section className="card stage" style={{ textAlign: "center" }}>
        <h1>Hongera! Well done 🌟</h1>
        <p className="small">Test 1 saved on this device.</p>
        <div className="grid2" style={{ margin: "16px 0" }}>
          <div className="card lo"><div className="big">{summary.correct}/{summary.total}</div><p className="small">correct</p></div>
          <div className="card lo"><div className="big">{summary.medianRtMs ?? "-"}</div><p className="small">median ms (correct)</p></div>
        </div>
        {summary.anticipatory > 0 && <p className="small">{summary.anticipatory} very fast tap(s) under 200 ms were excluded from timing.</p>}
        <div className="row wrap" style={{ justifyContent: "center", marginTop: 12 }}>
          <button className="btn ghost" onClick={onExit}>Back to dashboard</button>
          <button className="btn" onClick={() => onExit("digitspan")}>Next: Digit Span →</button>
        </div>
      </section>
    );

  return (
    <>
      <section className="card">
        <div className="row between">
          <div className="grow"><span className="tag">CBC Math · Number Concept</span><h2>Test 1 of 7: Subitizing</h2></div>
          <span className="pill" style={{ background: "var(--accent-dk)" }}>{item?.practice ? "Practice" : `Item ${scoredIdx} / 12`}</span>
        </div>
        <div className="bar" style={{ margin: "10px 0" }}><i style={{ width: `${pct}%` }} /></div>
        <div className="row">
          <button className="btn rose grow" onClick={() => speech.say(prompt)}>🔊 Sikiliza Maelekezo</button>
          <button className="btn ghost" onClick={pause} disabled={phase === "paused"} aria-label="Pause">⏸ Pumzika</button>
        </div>
      </section>

      <section className="card stage" style={{ display: "flex", flexDirection: "column", gap: 14, alignItems: "center", minHeight: 360 }}>
        <h1 style={{ textAlign: "center" }}>Ni kisanduku gani kina nukta NYINGI zaidi?</h1>
        <p className="small" style={{ textAlign: "center" }}>Which box has MORE dots?</p>
        {phase === "paused" ? (
          <div style={{ textAlign: "center", padding: 24 }}>
            <p style={{ marginBottom: 12 }}>Imesimama (Paused). This item will restart.</p>
            <button className="btn" onClick={resume}>▶ Endelea (Resume)</button>
          </div>
        ) : (
          <div className="stage-grid" aria-live="off">
            {["A", "B"].map((k) => (
              <div key={k} style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center" }}>
                <button className="box" disabled={phase !== "stim"} onPointerDown={(e) => answer(k, e)}
                  onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && phase === "stim" && t0 !== null) { e.preventDefault(); answer(k, e.nativeEvent); } }}
                  aria-label={`Sanduku ${k}`}>
                  {phase === "stim" && item ? <Dots pts={k === "A" ? item.dotsA : item.dotsB} /> : null}
                </button>
                <span className="pill">Sanduku {k}</span>
              </div>
            ))}
          </div>
        )}
        <div className="pill" style={{ background: "#fff8", minHeight: 40 }} role="status">
          {phase === "feedback" ? `Jibu limehifadhiwa ✓ · Kasi: ${(liveMs / 1000).toFixed(2)}s` : phase === "stim" ? "Gusa sasa! (Tap now)" : "Tayari… (Get ready)"}
        </div>
      </section>

      <section className="card lo">
        <h3 style={{ marginBottom: 8 }}>Uchunguzi wa Mwalimu (Teacher notes)</h3>
        <div className="chips">
          {OBS.map((o) => (
            <button key={o} className="chip" aria-pressed={!!obs[o]} onClick={() => setObs({ ...obs, [o]: !obs[o] })}>{obs[o] ? "✓ " : ""}{o}</button>
          ))}
        </div>
      </section>
    </>
  );
}

/* ---------- Screen 3: Auditory digit span (speech synthesis) ---------- */
function randomDigits(len) {
  const out = [];
  while (out.length < len) {
    const d = Math.floor(Math.random() * 10);
    if (out[out.length - 1] !== d) out.push(d);
  }
  return out;
}

function DigitSpanTest({ speech, onComplete, onExit }) {
  const [phase, setPhase] = useState("intro"); // intro | playing | respond | feedback | paused | done
  const [len, setLen] = useState(2);
  const [attempt, setAttempt] = useState(0); // 0 or 1 within a length
  const [seq, setSeq] = useState([]);
  const [entry, setEntry] = useState([]);
  const [replays, setReplays] = useState(1);
  const [visual, setVisual] = useState(null); // digit flashed on screen when audio is unavailable
  const [summary, setSummary] = useState(null);
  const trialsRef = useRef([]);
  const lenRes = useRef({}); // len -> [bool, bool]
  const t0 = useRef(0);
  const modality = useRef("audio");
  const token = useRef(0);

  const audioOK = speech.supported && speech.enabled;

  const play = useCallback(
    async (digits) => {
      const my = ++token.current;
      setPhase("playing");
      const words = DIGIT_WORDS[speech.effLang];
      if (!audioOK) {
        modality.current = "visual-fallback";
        for (const d of digits) {
          if (token.current !== my) return;
          setVisual(d);
          await sleep(900);
          setVisual(null);
          await sleep(250);
        }
      } else {
        await speech.speak(speech.effLang === "sw" ? "Sikiliza." : "Listen.");
        await sleep(300);
        for (const d of digits) {
          if (token.current !== my) return;
          await speech.speak(words[d], { rate: 0.8 });
          await sleep(650); // ~1 digit per second overall; exact pacing varies by device voice
        }
      }
      if (token.current !== my) return;
      t0.current = performance.now(); // response clock starts when the last digit ends
      setPhase("respond");
    },
    [audioOK, speech]
  );

  const beginTrial = (L) => {
    const s = randomDigits(L);
    setSeq(s);
    setEntry([]);
    setReplays(1);
    play(s);
  };

  const start = () => {
    trialsRef.current = [];
    lenRes.current = {};
    setLen(2);
    setAttempt(0);
    beginTrial(2);
  };

  useEffect(() => () => { token.current++; speech.stop(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const replay = () => {
    if (replays < 1 || phase !== "respond") return;
    setReplays(0);
    setEntry([]);
    play(seq);
  };

  const press = useCallback(
    (d) => phase === "respond" && setEntry((e) => (e.length < len ? [...e, d] : e)),
    [phase, len]
  );
  const back = useCallback(() => phase === "respond" && setEntry((e) => e.slice(0, -1)), [phase]);

  useEffect(() => {
    if (phase !== "respond") return undefined;
    const onKey = (e) => {
      if (/^[0-9]$/.test(e.key)) press(Number(e.key));
      else if (e.key === "Backspace") back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, press, back]);

  const submit = () => {
    if (entry.length !== len) return;
    const latency = Math.round((performance.now() - t0.current) * 10) / 10;
    const correct = entry.join("") === seq.join("");
    trialsRef.current.push({ length: len, attempt, sequence: seq.join(""), response: entry.join(""), correct, latencyMs: latency, replayUsed: replays === 0, modality: modality.current, lang: speech.effLang });
    lenRes.current[len] = [...(lenRes.current[len] || []), correct];
    setPhase("feedback");
    setTimeout(() => nextStep(correct), 900);
  };

  const nextStep = (correct) => {
    if (attempt === 0) {
      setAttempt(1);
      beginTrial(len);
      return;
    }
    const both = lenRes.current[len];
    if (both.every((x) => !x) || len >= MAX_SPAN) return finish();
    setLen(len + 1);
    setAttempt(0);
    beginTrial(len + 1);
  };

  const finish = () => {
    const passed = Object.entries(lenRes.current).filter(([, r]) => r.some(Boolean)).map(([l]) => Number(l));
    const span = passed.length ? Math.max(...passed) : 0;
    const s = {
      span, score: Math.round((span / MAX_SPAN) * 100), modality: modality.current, lang: speech.effLang,
      note: `Longest forward span: ${span} digit${span === 1 ? "" : "s"}${modality.current === "visual-fallback" ? " (shown visually: audio unavailable)" : ""}`,
    };
    setSummary(s);
    setPhase("done");
    onComplete("digitspan", s, trialsRef.current);
  };

  const pause = () => { token.current++; speech.stop(); setPhase("paused"); };
  const resume = () => { setEntry([]); play(seq); };

  const totalTrialsHint = `Trial ${attempt + 1} of 2 · ${len} digits`;

  if (phase === "intro")
    return (
      <section className="card stage" style={{ textAlign: "center" }}>
        <span className="tag">Test 7 of 7 · Working memory</span>
        <h1 style={{ margin: "8px 0" }}>Digit Span Memory</h1>
        <p>Sikiliza kisha urudie nambari kwa mpangilio sahihi.</p>
        <p className="small" style={{ margin: "6px 0 16px" }}>Listen, then tap the numbers in the same order. Starts at 2 digits and grows. Digits are never shown on screen.</p>
        <div className="row wrap" style={{ justifyContent: "center" }}>
          <button className="btn" onClick={start}>Anza (Start) →</button>
        </div>
        {!audioOK && <p className="warn" style={{ marginTop: 12 }}>Audio is off or not supported on this browser. Digits will flash on screen instead and the result is marked "visual", which is not a valid auditory span.</p>}
        {speech.swMissing && <p className="warn" style={{ marginTop: 12 }}>No Kiswahili voice found on this device: digits are spoken in English.</p>}
      </section>
    );

  if (phase === "done")
    return (
      <section className="card stage" style={{ textAlign: "center" }}>
        <h1>Asante sana! Thank you 🌟</h1>
        <div className="card lo" style={{ margin: "16px 0" }}><div className="big">{summary.span}</div><p className="small">digits in the longest correct forward sequence</p></div>
        <p className="small">Saved on this device.</p>
        <div className="row wrap" style={{ justifyContent: "center", marginTop: 12 }}>
          <button className="btn ghost" onClick={() => onExit()}>Back to dashboard</button>
          <button className="btn" onClick={() => onExit("report")}>See IEP / EARC →</button>
        </div>
      </section>
    );

  return (
    <>
      <section className="card">
        <div className="row between">
          <div className="grow"><span className="tag">Auditory · Forward span</span><h2>Test 7 of 7: Kumbukumbu ya Nambari</h2></div>
          <span className="pill" style={{ background: "var(--accent-dk)" }}>{totalTrialsHint}</span>
        </div>
      </section>

      <section className="card stage" style={{ display: "flex", flexDirection: "column", gap: 16, alignItems: "center" }}>
        <h1 style={{ textAlign: "center" }}>Sikiliza kisha urudie nambari</h1>
        <p className="small" style={{ textAlign: "center" }}>Listen carefully, then tap the numbers in the exact order heard.</p>

        {phase === "playing" && (
          <>
            <div className="wave" aria-hidden="true">{Array.from({ length: 11 }).map((_, i) => <i key={i} />)}</div>
            <div className="big" style={{ minHeight: 56 }} aria-live="off">{visual !== null ? visual : "🔊"}</div>
            <p className="small" role="status">Sauti inacheza… (Playing)</p>
            <button className="btn ghost" onClick={pause}>⏸ Pumzika</button>
          </>
        )}

        {phase === "paused" && (
          <div style={{ textAlign: "center" }}>
            <p style={{ marginBottom: 12 }}>Imesimama (Paused). This trial will restart.</p>
            <button className="btn" onClick={resume}>▶ Endelea (Resume)</button>
          </div>
        )}

        {(phase === "respond" || phase === "feedback") && (
          <>
            <div className="slots" role="group" aria-label="Your answer">
              {Array.from({ length: len }).map((_, i) => (
                <div key={i} className={`slot ${i === entry.length && phase === "respond" ? "act" : ""}`}>{entry[i] ?? ""}</div>
              ))}
            </div>
            <p className="small" role="status">{phase === "feedback" ? "Asante! Jibu limehifadhiwa ✓" : `Nafasi ${Math.min(entry.length + 1, len)} / ${len}`}</p>
            <div className="keypad" aria-label="Number keypad">
              {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => <button key={d} className="key" disabled={phase !== "respond"} onClick={() => press(d)}>{d}</button>)}
              <button className="key" disabled={phase !== "respond"} onClick={back} aria-label="Backspace">⌫</button>
              <button className="key" disabled={phase !== "respond"} onClick={() => press(0)}>0</button>
              <button className="key" style={{ background: "var(--primary)", color: "#fff" }} disabled={phase !== "respond" || entry.length !== len} onClick={submit} aria-label="Submit">✓</button>
            </div>
            <button className="btn rose" onClick={replay} disabled={replays < 1 || phase !== "respond"}>↻ Rudia Sauti ({replays} left)</button>
          </>
        )}
      </section>
    </>
  );
}

/* ---------- Screen 4: Profile, IEP editor, PDF export ---------- */
function ReportScreen({ learner, session, results, iep, onIepChange, onSave, onExport, notify }) {
  const profile = useMemo(() => computeProfile(results), [results]);
  const [filter, setFilter] = useState("all");
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ title: "", cat: "literacy", comp: COMPETENCIES[0], note: "" });
  const [busy, setBusy] = useState("");
  const accs = iep.accommodations;
  const shown = accs.filter((a) => filter === "all" || a.cat === filter);
  const upd = (id, patch) => onIepChange({ ...iep, accommodations: accs.map((a) => (a.id === id ? { ...a, ...patch } : a)) });
  const done = TESTS.filter((t) => results[t.key]).length;

  const exportNow = async (kind) => {
    setBusy(kind);
    await sleep(30); // let the button state paint before the synchronous PDF build
    try {
      const name = onExport(kind);
      notify(`Downloaded ${name}`);
    } catch (e) {
      console.error(e);
      notify("PDF could not be created on this device.");
    }
    setBusy("");
  };

  return (
    <>
      <section className="card">
        <span className="pill">{learner.code} · Grade {learner.grade} · Age {learner.age}</span>
        <h1 style={{ margin: "10px 0 4px" }}>Functional Learning Profile & CBC IEP</h1>
        <p className="small">{done} of 7 tasks completed {session?.sample ? "· SAMPLE DATA" : ""}</p>
        <p className="warn" style={{ marginTop: 12 }}>{NOTICE}</p>
      </section>

      <section className="card lo" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <h2>Screening results</h2>
        {profile.rows.map((r) => (
          <div key={r.key}>
            <div className="row between small"><b>{r.n}. {r.title}</b><span>{r.score === null ? "Not administered" : `${Math.round(r.score)}% · ${r.band.label}`}</span></div>
            <Bar score={r.score} tone={r.band?.tone} />
            {r.note && <p className="small">{r.note}</p>}
          </div>
        ))}
        <h3 style={{ marginTop: 6 }}>Support indicators</h3>
        {profile.groups.map((g) => (
          <div key={g.key} className="row between small"><b>{g.label}</b><span>{g.text}{g.done ? ` (${g.done}/${g.total} tasks)` : ""}</span></div>
        ))}
        <p className="small">Bands use provisional cut-offs (75+ on track, 50-74 monitor, &lt;50 priority). Confirm with your SNE specialist.</p>
      </section>

      <section className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="row between"><h2>CBC IEP accommodations</h2><span className="pill">{accs.filter((a) => a.on).length} active</span></div>
        <div className="chips">
          {[["all", `All (${accs.length})`], ["literacy", "Literacy"], ["numeracy", "Numeracy"], ["sensory", "Sensory & Exam"]].map(([k, l]) => (
            <button key={k} className="chip" aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>
          ))}
        </div>
        {shown.map((a) => (
          <article key={a.id} className={`acc ${a.on ? "" : "off"}`}>
            <div className="row between">
              <div className="grow"><span className="tag">{CAT_LABEL[a.cat]} · {a.comp}</span><h4>{a.title}</h4></div>
              <button className="switch" role="switch" aria-checked={a.on} aria-label={`Toggle ${a.title}`} onClick={() => upd(a.id, { on: !a.on })} />
            </div>
            <div className="field"><label htmlFor={`n-${a.id}`}>Teacher classroom instruction note</label>
              <textarea id={`n-${a.id}`} rows={2} value={a.note} onChange={(e) => upd(a.id, { note: e.target.value })} /></div>
          </article>
        ))}
        {!adding ? (
          <button className="btn ghost" onClick={() => setAdding(true)}>＋ Add custom accommodation</button>
        ) : (
          <form className="acc" onSubmit={(e) => {
            e.preventDefault();
            if (!draft.title.trim()) return;
            onIepChange({ ...iep, accommodations: [...accs, { id: `c${Date.now()}`, ...draft, title: draft.title.trim(), note: draft.note.trim() || "Custom accommodation active for learner.", on: true }] });
            setDraft({ title: "", cat: "literacy", comp: COMPETENCIES[0], note: "" });
            setAdding(false);
            notify("Custom accommodation added");
          }}>
            <div className="field"><label htmlFor="ct">Strategy title</label><input id="ct" required value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></div>
            <div className="grid2">
              <div className="field"><label htmlFor="cc">Category</label><select id="cc" value={draft.cat} onChange={(e) => setDraft({ ...draft, cat: e.target.value })}>{Object.entries(CAT_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
              <div className="field"><label htmlFor="cp">CBC core competency</label><select id="cp" value={draft.comp} onChange={(e) => setDraft({ ...draft, comp: e.target.value })}>{COMPETENCIES.map((c) => <option key={c}>{c}</option>)}</select></div>
            </div>
            <div className="field"><label htmlFor="cn">Implementation note</label><textarea id="cn" rows={2} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} /></div>
            <div className="row"><button className="btn grow" type="submit">Add to IEP</button><button className="btn ghost" type="button" onClick={() => setAdding(false)}>Cancel</button></div>
          </form>
        )}
      </section>

      <section className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h2>Sign-off & EARC referral</h2>
        <div className="row between"><div className="grow"><h4>Recommend EARC stage 2 referral</h4><p className="small">Included on the referral slip.</p></div>
          <button className="switch" role="switch" aria-checked={iep.earcReferral} aria-label="Toggle EARC referral" onClick={() => onIepChange({ ...iep, earcReferral: !iep.earcReferral })} /></div>
        <div className="field"><label htmlFor="sum">Summative teacher notes</label><textarea id="sum" rows={4} value={iep.summary} onChange={(e) => onIepChange({ ...iep, summary: e.target.value })} /></div>
        <button className="btn block" onClick={onSave}>✓ Save & update IEP plan</button>
        <button className="btn sec block" disabled={!!busy} onClick={() => exportNow("iep")}>{busy === "iep" ? "Creating PDF…" : "⬇ Export IEP document (PDF)"}</button>
        <button className="btn sec block" disabled={!!busy} onClick={() => exportNow("earc")}>{busy === "earc" ? "Creating PDF…" : "⬇ Export EARC referral slip (PDF)"}</button>
        <p className="small">PDFs are built in your browser and download immediately. No data leaves the device.</p>
      </section>
    </>
  );
}

/* ---------- App shell + state transitions ---------- */
const DEFAULT_LEARNER = { id: null, code: "STU-NBO-0001", grade: "4", age: "9", school: "", assessor: "" };
const NAV = [
  { key: "dashboard", icon: "🏠", label: "Dashboard" },
  { key: "subitizing", icon: "🔵", label: "Direct Test" },
  { key: "digitspan", icon: "👂", label: "Auditory" },
  { key: "report", icon: "📄", label: "IEP / EARC" },
];

export default function App() {
  const [screen, setScreen] = useState("dashboard");
  const [booted, setBooted] = useState(false);
  const [storageOk, setStorageOk] = useState(true);
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  const [dys, setDys] = useState(false);
  const [audioOn, setAudioOn] = useState(true);
  const [lang, setLang] = useState("en");
  const [learner, setLearner] = useState(DEFAULT_LEARNER);
  const [session, setSession] = useState({ id: null, run: 1, sample: false });
  const [results, setResults] = useState({});
  const [iep, setIep] = useState(emptyIep());
  const [toast, setToast] = useState("");
  const [testKey, setTestKey] = useState(0); // remount test screens when relaunched
  const speech = useSpeech(lang, audioOn);

  const toastTimer = useRef(0);
  const iepTimer = useRef(0);
  const notify = useCallback((m) => {
    setToast(m);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2600);
  }, []);

  // Run a storage call without letting a blocked/unavailable IndexedDB crash the app.
  const store = useCallback(async (fn) => {
    try {
      return await fn();
    } catch (e) {
      console.error("IndexedDB error", e);
      setStorageOk(false);
      return undefined;
    }
  }, []);

  const loadLearner = useCallback(async (l) => {
    let s = await latestSession(l.id);
    if (!s) s = await startSession(l.id);
    setLearner(l);
    setSession(s);
    setResults(await getResults(s.id));
    const saved = await getIep(s.id);
    setIep(saved || emptyIep(!!s.sample));
  }, []);

  // Boot: restore settings and the most recent learner from IndexedDB.
  useEffect(() => {
    (async () => {
      await store(async () => {
        setDys(await getSetting("dyslexic", false));
        setAudioOn(await getSetting("audio", true));
        setLang(await getSetting("lang", "en"));
        let l = await latestLearner();
        if (!l) l = await upsertLearner(DEFAULT_LEARNER);
        await loadLearner(l);
      });
      setBooted(true);
    })();
    const up = () => setOnline(true), down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, [store, loadLearner]);

  const go = (s) => { speech.stop(); setScreen(s); window.scrollTo?.(0, 0); };
  const launch = (key) => { setTestKey((k) => k + 1); go(key === "digitspan" ? "digitspan" : "subitizing"); };
  const persistSetting = (k, v) => store(() => setSetting(k, v));

  const onComplete = async (key, summary, trials) => {
    setResults((r) => ({ ...r, [key]: summary }));
    if (session.id) await store(async () => { await saveTrials(session.id, key, trials); await saveTestResult(session.id, key, summary); });
  };
  const onExitTest = (to) => {
    if (to === "digitspan") launch("digitspan");
    else go(to === "report" ? "report" : "dashboard");
  };

  const saveLearnerForm = async (f) => {
    const ok = await store(async () => { await loadLearner(await upsertLearner(f)); return true; });
    if (!ok) setLearner({ ...learner, ...f });
    notify("Learner saved on this device");
  };
  const newRun = async () => {
    const ok = await store(async () => {
      const s = await startSession(learner.id);
      setSession(s); setResults({}); setIep(emptyIep());
      return true;
    });
    if (!ok) { setSession({ id: null, run: session.run + 1, sample: false }); setResults({}); setIep(emptyIep()); }
    notify("New screening run started");
  };
  const loadSample = async () => {
    const rows = Object.fromEntries(TESTS.map((t) => [t.key, { ...SAMPLE[t.key], sample: true }]));
    const s = (await store(() => startSession(learner.id, { sample: true }))) || { id: null, run: session.run + 1, sample: true };
    setSession(s); setResults(rows); const sampleIep = emptyIep(true); setIep(sampleIep);
    if (s.id) await store(async () => { for (const [k, v] of Object.entries(rows)) await saveTestResult(s.id, k, v); await saveIep(s.id, learner.id, sampleIep); });
    notify("Sample results loaded (not a real learner)");
  };
  const deleteData = async () => {
    if (!window.confirm(`Delete ALL stored data for ${learner.code} on this device? This cannot be undone.`)) return;
    if (learner.id) await store(() => deleteLearnerData(learner.id));
    const l = (await store(() => upsertLearner(DEFAULT_LEARNER))) || DEFAULT_LEARNER;
    await store(() => loadLearner(l));
    if (!learner.id) { setResults({}); setIep(emptyIep()); }
    notify("Learner data deleted");
  };

  const onIepChange = (next) => {
    setIep(next);
    // autosave (debounced) so edits survive a reload even without pressing Save
    clearTimeout(iepTimer.current);
    iepTimer.current = setTimeout(() => session.id && store(() => saveIep(session.id, learner.id, next)), 500);
  };
  const saveIepNow = async () => {
    if (session.id) await store(() => saveIep(session.id, learner.id, iep));
    notify(storageOk ? "IEP plan saved on this device" : "Storage unavailable: not saved");
  };

  if (!booted) return <div className="sne"><style>{CSS}</style><main><p>Loading…</p></main></div>;

  return (
    <div className={`sne ${dys ? "dys" : ""}`}>
      <style>{CSS}</style>
      <header className="hdr">
        <div className="row between wrap">
          <div className="grow"><div className="brand">CBC SNE Screener</div><div className="sub">Dyslexia & dyscalculia functional screening</div></div>
          <span className={`pill ${online ? "" : "off"}`}><span className="dot" />{online ? "Online · data saved on device" : "Nje ya Mtandao · Offline, saved locally"}</span>
        </div>
        <div className="row wrap" style={{ marginTop: 6 }}>
          <button className="pill btn" aria-pressed={dys} onClick={() => { setDys(!dys); persistSetting("dyslexic", !dys); }}>Aa OpenDyslexic</button>
          <button className="pill btn" aria-pressed={audioOn} onClick={() => { setAudioOn(!audioOn); persistSetting("audio", !audioOn); if (audioOn) speech.stop(); }}>🔊 Audio {audioOn ? "on" : "off"}</button>
          <button className="pill btn" aria-label="Speech language" onClick={() => { const n = lang === "en" ? "sw" : "en"; setLang(n); persistSetting("lang", n); }}>🗣 {lang === "en" ? "English" : "Kiswahili"}</button>
        </div>
        {!storageOk && <p className="warn" style={{ marginTop: 6 }}>Local storage is unavailable (private window or blocked). Results will be lost when you close this tab.</p>}
      </header>

      <main>
        {screen === "dashboard" && (
          <Dashboard learner={learner} session={session} results={results} speech={speech}
            onSaveLearner={saveLearnerForm} onLaunch={launch} onNewRun={newRun} onSample={loadSample} onDelete={deleteData} />
        )}
        {screen === "subitizing" && <SubitizingTest key={`s${testKey}`} speech={speech} onComplete={onComplete} onExit={onExitTest} />}
        {screen === "digitspan" && <DigitSpanTest key={`d${testKey}`} speech={speech} onComplete={onComplete} onExit={onExitTest} />}
        {screen === "report" && (
          <ReportScreen learner={learner} session={session} results={results} iep={iep} notify={notify}
            onIepChange={onIepChange} onSave={saveIepNow} onExport={(kind) => exportPdf(kind, { learner, session, results, iep })} />
        )}
      </main>

      <nav className="nav" aria-label="Screens">
        {NAV.map((n) => (
          <button key={n.key} aria-current={screen === n.key ? "page" : undefined} onClick={() => (n.key === "subitizing" || n.key === "digitspan" ? launch(n.key) : go(n.key))}>
            <span className="ic" aria-hidden="true">{n.icon}</span>{n.label}
          </button>
        ))}
      </nav>
      <Toast msg={toast} />
    </div>
  );
}
