// schema.js — offline storage for the CBC SNE Screener (Dexie.js / IndexedDB)
//
// Install:  npm i dexie
// Use in App.jsx:  import { db, upsertLearner, startSession, ... } from "./schema";
//
// Privacy: everything stays on the device. Store a pseudonymous learner CODE
// (e.g. STU-NBO-0001), not the child's full name.

import Dexie from "dexie";

export const db = new Dexie("cbc_sne_screener");

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
export async function upsertLearner({ code, grade, age, school, assessor }) {
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

export async function latestLearner() {
  return (await db.learners.orderBy("updatedAt").last()) || null;
}

// ---- sessions (a "screening run") -----------------------------------------
export async function startSession(learnerId, { sample = false } = {}) {
  const runs = await db.sessions.where("learnerId").equals(learnerId).count();
  const rec = { learnerId, startedAt: now(), status: "in_progress", run: runs + 1, sample };
  rec.id = await db.sessions.add(rec);
  return rec;
}

export async function latestSession(learnerId) {
  const all = await db.sessions.where("learnerId").equals(learnerId).toArray();
  return all.sort((a, b) => b.startedAt - a.startedAt)[0] || null;
}

// ---- trials + per-test summary --------------------------------------------
export async function saveTrials(sessionId, testKey, trials) {
  await db.transaction("rw", db.trials, async () => {
    await db.trials.where("[sessionId+testKey]").equals([sessionId, testKey]).delete();
    await db.trials.bulkAdd(trials.map((t) => ({ ...t, sessionId, testKey })));
  });
}

export async function saveTestResult(sessionId, testKey, summary) {
  await db.testResults.put({ key: `${sessionId}:${testKey}`, sessionId, testKey, ...summary, savedAt: now() });
}

export async function getResults(sessionId) {
  const rows = await db.testResults.where("sessionId").equals(sessionId).toArray();
  return Object.fromEntries(rows.map((r) => [r.testKey, r]));
}

// ---- IEP draft -------------------------------------------------------------
export async function getIep(sessionId) {
  return (await db.ieps.get(sessionId)) || null;
}

export async function saveIep(sessionId, learnerId, data) {
  await db.ieps.put({ ...data, sessionId, learnerId, updatedAt: now() });
}

// ---- settings --------------------------------------------------------------
export async function getSetting(key, fallback) {
  const row = await db.settings.get(key);
  return row ? row.value : fallback;
}
export async function setSetting(key, value) {
  await db.settings.put({ key, value });
}

// ---- deletion (data-protection friendly) ----------------------------------
export async function deleteLearnerData(learnerId) {
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
