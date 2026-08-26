// data.js — the app's one door to Firebase. Nothing in here touches the page.
//
// Every other file imports from this one. The rule that matters most:
// no Firestore read happens until whenSignedIn() has resolved. Reading
// before sign-in fails silently against the security rules, and that
// bug has bitten us before.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, deleteDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyBiwsuVyEormZua4fUh7rLeIAQp0BZ-y8A",
  authDomain: "epstools-2913e.firebaseapp.com",
  projectId: "epstools-2913e",
  storageBucket: "epstools-2913e.firebasestorage.app",
  messagingSenderId: "91969549327",
  appId: "1:91969549327:web:6eea1d04d68eb01dabdf7a",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

const DOMAIN = "@eastportlandsash.com";
const JOBS = "pm_projects";

// ── Sign-in ──────────────────────────────────────────────────────────

/** True when this Firebase user is one of ours. */
export function isEpsUser(user) {
  return !!(user && user.email && user.email.toLowerCase().endsWith(DOMAIN));
}

// One promise for the whole page. Resolves the first time an EPS user is
// signed in, and stays resolved. Anything that reads Firestore awaits it.
let _resolveSignedIn;
const _signedIn = new Promise((resolve) => { _resolveSignedIn = resolve; });
onAuthStateChanged(auth, (user) => { if (isEpsUser(user)) _resolveSignedIn(user); });

/** Resolves with the user once an @eastportlandsash.com account is signed in. */
export function whenSignedIn() { return _signedIn; }

/** Google popup sign-in. Rejects a non-EPS account and signs it back out. */
export async function signIn() {
  const res = await signInWithPopup(auth, new GoogleAuthProvider());
  if (!isEpsUser(res.user)) {
    await signOut(auth);
    throw new Error("That account is not an East Portland Sash account.");
  }
  return res.user;
}

export function signOutUser() { return signOut(auth); }

/** Subscribe to sign-in changes (used by the gate in index.html). */
export function onAuthChange(fn) { return onAuthStateChanged(auth, fn); }

// ── Jobs (pm_projects) ───────────────────────────────────────────────

/** Every job, each with its Firestore id attached as `id`. */
export async function loadJobs() {
  await whenSignedIn();
  const snap = await getDocs(collection(db, JOBS));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** One job by id, or null if it does not exist. */
export async function getJob(id) {
  await whenSignedIn();
  const snap = await getDoc(doc(db, JOBS, id));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/** Merge `patch` into the job and stamp updatedAt. Creates the doc if new. */
export async function saveJob(id, patch) {
  await whenSignedIn();
  const data = { ...patch, updatedAt: serverTimestamp() };
  delete data.id; // the id is the doc name, not a field
  await setDoc(doc(db, JOBS, id), data, { merge: true });
}

/** Create a brand-new job. Fails if the id is already taken. */
export async function createJob(id, data) {
  await whenSignedIn();
  const ref = doc(db, JOBS, id);
  const existing = await getDoc(ref);
  if (existing.exists()) throw new Error(`Est # ${id} already exists`);
  await setDoc(ref, { ...data, createdAt: serverTimestamp() });
}

export async function deleteJob(id) {
  await whenSignedIn();
  await deleteDoc(doc(db, JOBS, id));
}

// ── Boards ───────────────────────────────────────────────────────────

/** boards/dashboard — the strip the OS writes (lead times, unbilled, A/R). */
export async function loadDashboard() {
  await whenSignedIn();
  const snap = await getDoc(doc(db, "boards", "dashboard"));
  return snap.exists() ? snap.data() : null;
}

/** boards/schedule cards, as the old scheduler stored them. Reworked in step 3. */
export async function loadScheduleCards() {
  await whenSignedIn();
  const snap = await getDoc(doc(db, "boards", "schedule"));
  return snap.exists() ? (snap.data().cards || []) : [];
}

export async function saveScheduleCards(cards) {
  await whenSignedIn();
  await setDoc(doc(db, "boards", "schedule"), { cards }, { merge: true });
}

// ── Formatting ───────────────────────────────────────────────────────

/** "$12,345" — whole dollars, comma-grouped. */
export function money(n) {
  return "$" + Math.round(Number(n) || 0).toLocaleString();
}

/** "2026-08-25" → "8/25". Anything else comes back as-is, blank as "—". */
export function fmtDate(s) {
  if (!s) return "—";
  const parts = String(s).split("-");
  if (parts.length !== 3) return s;
  return parseInt(parts[1], 10) + "/" + parseInt(parts[2], 10);
}

/** Firestore Timestamp (or Date/string) → "Aug 25, 3:12 PM". */
export function fmtStamp(ts) {
  const d = ts && ts.toDate ? ts.toDate() : (ts ? new Date(ts) : null);
  if (!d || isNaN(d)) return "";
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
