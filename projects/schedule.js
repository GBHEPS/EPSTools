// schedule.js — the Schedule tab: two views on the same page.
//
//   Forecast  the OS schedule board (boards/dashboard: lanes × weeks). Drag a bar
//             to pin its job to a week; the OS repacks the rest on the next check.
//   Crew      the two-week crew board (boards/schedule cards), editable.
//
// Same conventions as jobs.js: views are HTML strings rendered into <main>,
// one delegated click listener reads data-act, every user string goes
// through esc(), and every Firestore read goes through data.js (which waits
// for sign-in). All data-act names here are prefixed "sch-" so they never
// collide with the jobs.js listener, which also sits on document.

import { db, whenSignedIn, loadDashboard, saveScheduleCards, loadJobs, saveJob, commitBoard, auth, addTimeOff, removeTimeOff, loadTimeOff } from "./data.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js";

// ── Constants ────────────────────────────────────────────────────────
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TYPES = { fab: "Shop Fab", paint: "Paint/Install", resto: "Resto", walk: "Walk", off: "Off" };
const LEGEND = [["walk", "Walk"], ["fab", "Fab"], ["resto", "Resto"], ["off", "Off"]];
const SAVE_DELAY = 600;
const CARD_H = 44, CARD_GAP = 3, CELL_MIN_H = 80;

// ── State ────────────────────────────────────────────────────────────
let root = null;                 // the <main> we render into
let wired = false;
let view = "crew";               // "forecast" | "crew"
let focus = null;                // "small" | "restoration" | "fab" | null
let loaded = false, loading = null;

let dash = null;                 // boards/dashboard
let jobs = [];                   // pm_projects, every status
let crew = [];                   // settings/crew members (active, in order)
let cards = [];                  // boards/schedule cards — the thing we edit
let prodClients = [];            // legacy autocomplete names, kept for the old board

let anchorMonday = mondayOf(new Date());
let typeFilters = new Set(["walk", "fab", "resto", "off"]);
let showJobStrip = true;

let hoverCardId = null;          // card under the mouse (Cmd/Ctrl+C copies it)
let copiedCard = null;           // a card waiting to be pasted
let selectedJobBar = null;       // a job-strip bar the user clicked
let copiedJobBar = null;

let modal = null;                // { id|null, emp, type, ... } while the card modal is open
let deleteId = null;

let tlGeom = null;               // forecast geometry (L, W, t0) so a drag can snap to weeks
let dragEndedAt = 0;             // a drop re-renders the board; the click that follows must not open anything

let saveTimer = null;
let savePending = false;         // true from the first edit until the write lands

// ── Entry points (index.html calls these) ────────────────────────────

/** Mount the tab. opts: { view: "forecast"|"crew", focus: "small"|"restoration"|"fab" } */
export function mountSchedule(viewEl, opts = {}) {
  root = viewEl;
  if (!wired) { wireEvents(); wired = true; }
  if (opts.view === "forecast" || opts.view === "crew") view = opts.view;
  else if (opts.focus) view = "forecast";
  focus = opts.focus || null;
  // Re-read on every mount (the Jobs tab may have pushed cards) unless an edit is still saving.
  if (!savePending) { loaded = false; loading = null; }
  root.innerHTML = `<div id="schedWrap" class="sched-wrap"><div class="loading-state">Loading schedule…</div></div>`;
  setHeaderNav("");
  ensureLoaded().then(render).catch((e) => {
    root.innerHTML = `<div class="empty-state"><div class="icon">⚠</div><p>${esc(e.message || String(e))}</p></div>`;
  });
}

/** True while a debounced save is still waiting or in flight. */
export function scheduleHasUnsaved() { return savePending; }

window.addEventListener("beforeunload", (e) => { if (savePending) { e.preventDefault(); e.returnValue = ""; } });

// ── Small helpers ────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const $ = (id) => document.getElementById(id);
function toast(msg, isError) {
  const t = $("toast"); if (!t) return;
  t.textContent = msg;
  t.className = "toast" + (isError ? " error" : "") + " show";
  clearTimeout(t._to); t._to = setTimeout(() => t.classList.remove("show"), 2800);
}
function setHeaderNav(html) { const h = $("headerNav"); if (h) h.innerHTML = html; }
let resizeTimer = null;
window.addEventListener("resize", () => { if (view === "forecast" && isMounted()) { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 150); } });
function isMounted() { return !!(root && root.isConnected && root.querySelector("#schedWrap")); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

// dates: the board thinks in "YYYY-MM-DD" keys and local Date objects
function mondayOf(date) { const d = new Date(date); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + (d.getDay() === 0 ? -6 : 1 - d.getDay())); return d; }
function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }
function key(date) { return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0"); }
function fromKey(k) { const [y, m, d] = String(k).split("-").map(Number); return new Date(y, m - 1, d); }
function fmt(date) { return (date.getMonth() + 1) + "/" + date.getDate(); }
function isToday(date) { return key(date) === key(new Date()); }
function daysBetween(a, b) { return Math.round((fromKey(b) - fromKey(a)) / 86400000); }
function addBizDays(k, n) { let d = fromKey(k), added = 0; while (added < n) { d = addDays(d, 1); if (d.getDay() % 6) added++; } return key(d); }
function weekDates(monday) { return Array.from({ length: 5 }, (_, i) => addDays(monday, i)); }

/** Legacy shop→fab, site→resto; paint folds into fab for the legend filter. */
function filterType(t) { return (t === "shop" || t === "paint") ? "fab" : t === "site" ? "resto" : (t || "fab"); }
function displayType(t) { return t === "shop" ? "fab" : t === "site" ? "resto" : (t || "fab"); }

function statusOf(p) { return p.status === "active" ? "pre-production" : (p.status || "pre-production"); }
function liveJobs() {
  return jobs.filter((p) => ["pre-production", "production"].includes(statusOf(p)))
    .sort((a, b) => String(a.clientLastName || "").localeCompare(String(b.clientLastName || "")));
}
function jobById(id) { return id ? jobs.find((j) => j.id === id) : null; }
function jobByLastName(name) {
  const n = String(name || "").trim().toLowerCase(); if (!n) return null;
  return liveJobs().find((j) => String(j.clientLastName || "").trim().toLowerCase() === n) || null;
}

// ── Loading ──────────────────────────────────────────────────────────
async function ensureLoaded() {
  if (loaded) return;
  if (!loading) loading = (async () => {
    const [d, j, c, s, t] = await Promise.all([loadDashboard(), loadJobs(), loadCrew(), loadScheduleDoc(), loadTimeOff().catch(() => null)]);
    if (t) localOut = t;
    dash = d; jobs = j; crew = c; cards = s.cards; prodClients = s.prodClients;
    overlayPins();
    loaded = true;
  })();
  await loading;
}

/** settings/crew → active members, in stored order. Falls back to whoever holds cards. */
async function loadCrew() {
  await whenSignedIn();
  try {
    const snap = await getDoc(doc(db, "settings", "crew"));
    const members = snap.exists() ? (snap.data().members || []) : [];
    return members.filter((m) => m && m.active !== false && m.initials).map((m) => ({ initials: String(m.initials), name: String(m.name || m.initials), role: String(m.role || "") }));
  } catch (e) { console.warn("settings/crew", e); return []; }
}

/** The whole boards/schedule doc (we need prodClients as well as cards). */
async function loadScheduleDoc() {
  await whenSignedIn();
  const snap = await getDoc(doc(db, "boards", "schedule"));
  const s = snap.exists() ? snap.data() : {};
  return { cards: Array.isArray(s.cards) ? s.cards : [], prodClients: Array.isArray(s.prodClients) ? s.prodClients : [] };
}

/** Row order for the board: the roster, then anyone else holding a card in this window. */
function rowEmps() {
  const list = crew.map((m) => m.initials);
  const start = key(anchorMonday), end = key(addDays(anchorMonday, 11));
  cards.forEach((c) => { if (c.emp && !list.includes(c.emp) && c.endDate >= start && c.startDate <= end) list.push(c.emp); });
  return list;
}
function empName(initials) { const m = crew.find((x) => x.initials === initials); return m ? m.name : initials; }

// ── Saving ───────────────────────────────────────────────────────────
function scheduleSave() {
  savePending = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await saveScheduleCards(cards);
      savePending = false;
      // step 4: write dates back to the job here (earliest fab/resto/walk card per jobId → pm_projects)
    } catch (e) {
      console.warn("schedule save failed", e);
      toast("Save failed — check connection. " + (e.message || ""), true);
    }
  }, SAVE_DELAY);
}

// ═════════════════════════════════════════════════════════════════════
// RENDER
// ═════════════════════════════════════════════════════════════════════

function render() {
  if (!isMounted()) return;
  const wrap = $("schedWrap"); if (!wrap) return;
  const sw = (v, label) => `<button class="sch-view-btn${view === v ? " active" : ""}" data-act="sch-view" data-view="${v}">${label}</button>`;
  const left = `<div class="sch-switch">${sw("forecast", "Forecast")}${sw("crew", "Crew")}</div>`;
  if (view === "forecast") {
    const draft = boardIsDraft();
    const submitted = dash?.committedAt ? `submitted ${esc(stampShort(dash.committedAt))}` : "never submitted";
    const submitBtn = draft
      ? `<button class="btn-header primary" data-act="sch-submit" title="Commit the board as it stands. The OS drafts client emails for red bars and moves their written weeks.">Submit board</button>`
      : `<button class="btn-header" disabled title="Nothing moved since the last submit">Board ${submitted}</button>`;
    const revertBtn = pinsDifferFromShipped()
      ? `<button class="btn-header" data-act="sch-revert" title="Put every pin back the way the OS last shipped the board">Revert</button>` : "";
    const clearBtn = anyPins()
      ? `<button class="btn-header" data-act="sch-clear" title="Clear every pin and let the OS place everything from the job folders">Clear pins</button>` : "";
    const outBtn = `<button class="btn-header" data-act="sch-out-add" title="Block out a holiday, a shop closure, or someone's time off">+ Time off</button>`;
    setHeaderNav(left + outBtn + `<span class="sch-stamp">board as of ${esc(dash?.leadTimesAsOf || "?")} · today ${esc(dash?.today || key(new Date()))}</span>` + revertBtn + clearBtn + submitBtn);
    wrap.innerHTML = renderForecast();
  } else {
    const label = fmt(anchorMonday) + " – " + fmt(addDays(anchorMonday, 11));
    setHeaderNav(left + `
      <div class="sch-nav">
        <button class="btn-header" data-act="sch-prev" title="Previous week (←)">◀</button>
        <span class="sch-week-label">${esc(label)}</span>
        <button class="btn-header" data-act="sch-next" title="Next week (→)">▶</button>
        <button class="btn-header" data-act="sch-today">Today</button>
      </div>
      <button class="btn-header" data-act="sch-print">⎙ Print</button>`);
    wrap.innerHTML = renderCrew();
    wrap.classList.toggle("paste-ready", !!(copiedCard || copiedJobBar));
  }
}

// ── Forecast: lanes × weeks, from boards/dashboard ───────────────────
function renderForecast() {
  const d = dash || {};
  const bars = d.timeline || [], marks = d.leadMarkers || [];
  const focusLead = (d.leadTimes || []).find((l) => l.key === focus);
  const title = focusLead ? `What's ahead of a new ${esc(focusLead.label.toLowerCase())} job — lands week of ${esc(focusLead.week)}` : "Schedule board";
  const pendingPins = bars.filter((b) => b.localPin).length;
  const note = `Forecast comes from the OS schedule board (shared/SCHEDULE.md), as of ${esc(d.leadTimesAsOf || "?")}. `
    + `Drag a bar to pin that job to a week — sideways for the week, up or down to change its lane. The OS treats a pin like a promise and packs everything else around it on the next schedule check. `
    + `A <b style="color:#c0392b">red</b> outline means you moved a job off a week the client was told; it stays a draft until you press <b>Submit board</b>. Then the OS drafts the client email, moves the written week, and the red clears on the next schedule check. Click ⊘ on a pinned bar to let it float again. `
    + `Storm and full-unit jobs show as a <b>chain</b>: measure → assembly → site fit → glazing → install, joined by a thin line. Drag a link and the ones after it slide on the next check; the ones before hold.`
    + (pendingPins ? ` <b>${pendingPins} pin${pendingPins > 1 ? "s" : ""} saved — the neighbors move on the next schedule check.</b>` : "");
  if (!bars.length) {
    return `<div class="sch-panel"><div class="sch-panel-head"><b>${title}</b></div>
      <div class="sch-empty">No timeline yet — ask the OS to run the schedule check.</div><div class="sch-note">${note}</div></div>`;
  }
  const day = 86400000, at = (s) => new Date(s + "T00:00:00");
  const today = at(d.today || key(new Date())); const t0 = mondayOf(today);
  const ends = bars.map((b) => at(b.start).getTime() + b.weeks * 7 * day).concat(marks.map((m) => at(m.start).getTime() + 14 * day));
  const nWeeks = Math.max(8, Math.ceil((Math.max(...ends) - t0) / (7 * day)) + 1);
  const L = 120, rowH = 26, laneGap = 12, top = 22;
  // Weeks stretch to fill the window (never under 56 px); the board scrolls only when it must.
  const avail = (root && root.clientWidth ? root.clientWidth : window.innerWidth) - 48;
  const W = Math.max(56, Math.floor((avail - L - 10) / nWeeks));
  tlGeom = { L, W, t0 };
  const cap = d.capacity || {};
  const lanes = [
    ["restoration", "Restoration" + (cap.restoration ? " · " + cap.restoration + " h/wk" : "")],
    ["fabrication", "Fabrication" + (cap.fabrication ? " · " + cap.fabrication + " h/wk" : "")],
    ["filler", "Onesie-twosie · ½ days"],
    ["out", "Out"],
  ];
  // Out row: holidays and time off. Board-added ones (source "board") can be removed here;
  // the rest come from eps/time-off.yaml. Entries saved this session show at once (localOut).
  const outBars = outEntries().map((e) => {
    const s0 = mondayOf(at(e.start)), e0 = at(e.end);
    const weeks = Math.max(1, Math.round((mondayOf(e0) - s0) / (7 * day)) + 1);
    const who = e.who === "SHOP" ? (e.note || "closed") : `${e.who} out${e.note ? " — " + e.note : ""}`;
    const days = e.start === e.end ? fmt(at(e.start)) : `${fmt(at(e.start))}–${fmt(e0)}`;
    return { ...e, isOut: true, lane: "out", start: key(s0), weeks, label: `${who} · ${days}` };
  });
  // pack bars into rows within each lane so overlaps don't stack on top of each other
  const laneRows = {}, laneY = {}; let y = top;
  lanes.forEach(([k]) => {
    const rows = [];
    (k === "out" ? outBars : bars.filter((b) => b.lane === k)).sort((a, b) => (a.start < b.start ? -1 : 1)).forEach((b) => {
      const s = at(b.start).getTime(), e = s + b.weeks * 7 * day;
      const row = rows.find((r) => r.end <= s);
      if (row) { row.end = e; row.items.push(b); } else rows.push({ end: e, items: [b] });
    });
    if (!rows.length) rows.push({ end: 0, items: [] });
    laneRows[k] = rows; laneY[k] = y; y += rows.length * rowH + laneGap;
  });
  const H = y + 18, Wt = L + nWeeks * W + 10;
  tlGeom.lanes = lanes.map(([k]) => ({ k, y0: laneY[k] - laneGap / 2, y1: laneY[k] + laneRows[k].length * rowH + laneGap / 2 }));
  tlGeom.H = H; tlGeom.Wt = Wt;
  const x = (s) => L + ((at(s) - t0) / (7 * day)) * W;
  const geomByIdx = {};
  const svg = [`<svg class="sch-tl-svg" width="${Wt}" height="${H}" viewBox="0 0 ${Wt} ${H}">`];
  tlGeom.lanes.forEach((ln) => svg.push(`<rect class="lane-drop" data-lane="${ln.k}" x="${L}" y="${ln.y0}" width="${nWeeks * W}" height="${ln.y1 - ln.y0}" visibility="hidden"/>`));
  const shortW = d.shortWeeks || {};
  for (let i = 0; i < nWeeks; i++) {
    const wd = new Date(t0.getTime() + i * 7 * day);
    const wk = key(wd);
    const shorts = Object.entries(shortW).filter(([, m]) => m[wk]);
    if (shorts.length) {
      const why = shorts.map(([ln, m]) => `${ln}: ${m[wk].hours} h — ${m[wk].why}`).join("\n");
      svg.push(`<rect class="short-week" x="${L + i * W}" y="${top - 6}" width="${W}" height="${H - top - 8}"><title>${esc("Short week\n" + why)}</title></rect>`);
      svg.push(`<text class="short-label" x="${L + i * W + W - 3}" y="${top - 9}" text-anchor="end">${esc(shorts.map(([, m]) => m[wk].hours + "h").join("/"))}</text>`);
    }
    svg.push(`<line class="${wd.getDate() <= 7 ? "month" : "grid"}" x1="${L + i * W}" y1="${top - 6}" x2="${L + i * W}" y2="${H - 14}"/>`);
    svg.push(`<text class="wk" x="${L + i * W + 3}" y="${top - 9}">${wd.getMonth() + 1}/${wd.getDate()}</text>`);
  }
  lanes.forEach(([k, label]) => {
    const y0 = laneY[k];
    svg.push(`<text class="lane-label" x="0" y="${y0 + 14}">${esc(label)}</text>`);
    laneRows[k].forEach((row, ri) => row.items.forEach((b) => {
      const bx = x(b.start), bw = Math.max(b.weeks * W - 3, 10), by = y0 + ri * rowH + 3;
      if (b.isOut) {
        const removable = b.source === "board" && b.id;
        const src = b.source === "holiday" ? "\nHoliday (eps/time-off.yaml)" : b.source === "board" ? "\nAdded on the board · ✕ removes it" : "\nFrom eps/time-off.yaml";
        svg.push(`<g class="tl-out"><title>${esc(b.label + src)}</title>`);
        svg.push(`<rect class="bar out${b.who === "SHOP" ? " shop" : ""}" x="${bx}" y="${by}" width="${bw}" height="${rowH - 6}"/>`);
        svg.push(`<text class="bar-label" x="${bx + 4}" y="${by + 12}">${esc(b.label)}</text>`);
        if (removable) svg.push(`<text class="bar-unpin" data-act="sch-out-remove" data-out="${esc(b.id)}" x="${bx + bw - 11}" y="${by + 12}"><title>Remove this block</title>✕</text>`);
        svg.push(`</g>`);
        return;
      }
      const pinned = !!b.pinned;
      const conflict = pinned && b.conflict ? b.conflict : "";
      const submitted = conflict && !pinIsDraft(b);
      const isLink = !!b.chain;
      const cls = "bar " + b.lane + (b.anchored ? " anchored" : "") + (pinned ? " pinned" : "") + (conflict ? " conflict" + (submitted ? " submitted" : "") : "") + (b.blocked ? " blocked" : "") + (isLink ? " link" : "");
      const chainNote = isLink ? `\n${b.chainType === "full-unit" ? "Full-unit" : "Storm"} chain, step: ${b.link}. ${b.link === "assembly" ? "Move this and every link after it moves." : "Move this and the links after it slide; the ones before hold."}` : "";
      const tip = `${b.label} — ${b.hours} h, ${b.weeks} wk from ${b.start}${b.commitment && b.commitment !== "forecast" ? " (" + b.commitment + ")" : ""}${chainNote}${pinned ? "\nPinned here by you" : ""}${conflict ? "\nClient was told week of " + conflict + (submitted ? " — submitted, email being drafted" : " — draft, press Submit board") : ""}${b.blocked ? "\nBlocked: " + b.blocked : ""}\nClick to open the job · drag to pin to a week`;
      const idx = bars.indexOf(b);
      if (isLink) geomByIdx[idx] = { x0: bx, x1: bx + bw, ym: by + (rowH - 6) / 2 };
      svg.push(`<g class="tl-bar${pinned ? " is-pinned" : ""}" data-act="sch-open-job" data-bar="${idx}" data-slug="${esc(b.slug || "")}" data-part="${esc(b.part || "site")}" data-label="${esc(b.label || "")}"><title>${esc(tip)}</title>`);
      svg.push(`<rect class="${cls}" x="${bx}" y="${by}" width="${bw}" height="${rowH - 6}"/>`);
      svg.push(`<text class="bar-label" x="${bx + 4}" y="${by + 12}">${esc(b.label)}${bw > 70 ? " · " + esc(b.hours) + "h" : ""}</text>`);
      if (conflict && bw > 90) svg.push(`<text class="bar-was" x="${bx + bw - 24}" y="${by + 12}" text-anchor="end">was ${esc(fmt(at(conflict)))}</text>`);
      if (pinned) svg.push(`<text class="bar-unpin" data-act="sch-unpin" data-bar="${idx}" x="${bx + bw - 11}" y="${by + 12}"><title>Unpin — let the OS place this job again</title>⊘</text>`);
      svg.push(`</g>`);
    }));
  });
  // Chain connectors: a thin line from the end of each link to the start of
  // the next, so the dead time between steps is the thing you see.
  const chains = {};
  bars.forEach((b, i) => { if (b.chain && geomByIdx[i]) (chains[b.chain] = chains[b.chain] || []).push({ b, g: geomByIdx[i] }); });
  const ORDER = { measure: 0, assembly: 1, fit: 2, paint: 2.5, glazing: 3, install: 4 };
  Object.values(chains).forEach((links) => {
    links.sort((p, q) => (ORDER[p.b.link] ?? 9) - (ORDER[q.b.link] ?? 9));
    for (let i = 1; i < links.length; i++) {
      const a = links[i - 1].g, c = links[i].g;
      const ax = a.x1, cx = c.x0, mid = ax + Math.max((cx - ax) / 2, 6);
      const path = cx >= ax - 2
        ? `M${ax},${a.ym} H${mid} V${c.ym} H${cx}`
        : `M${ax},${a.ym} h6 V${(a.ym + c.ym) / 2} H${cx - 6} V${c.ym} h6`;
      svg.push(`<path class="chain-link${cx < ax - 2 ? " backwards" : ""}" d="${path}"/>`);
    }
  });
  const tx = L + ((today - t0) / (7 * day)) * W;
  svg.push(`<line class="today" x1="${tx}" y1="${top - 6}" x2="${tx}" y2="${H - 14}"/>`);
  marks.forEach((m) => {
    const mx = x(m.start), my = laneY[m.lane] ?? top, hot = m.key === focus;
    svg.push(`<g class="tl-mark${hot ? " hot" : ""}" opacity="${hot ? 1 : 0.45}"><title>${esc("New " + m.desc + " would start week of " + m.start)}</title>`);
    svg.push(`<polygon class="marker" points="${mx},${my - 2} ${mx + 7},${my + 5} ${mx},${my + 12}"/>`);
    svg.push(`<text class="marker-label" x="${mx + 10}" y="${my + 9}">${hot ? "next opening" : ""}</text></g>`);
  });
  svg.push("</svg>");
  const legend = `<div class="sch-legend">
    <span><i style="background:#cfe0ee;border-color:#5a9aca"></i>restoration</span>
    <span><i style="background:#d4ebbb;border-color:#97C459"></i>fabrication</span>
    <span><i style="background:#ede2c4;border-color:#d4a820"></i>onesie-twosie</span>
    <span><i style="border-width:2px;border-color:#555"></i>date in writing</span>
    <span><i style="border-style:dashed;border-color:#b5651d;border-width:2px"></i>pinned by you</span>
    <span><i style="border-color:#c0392b;border-width:2px"></i>moved off a written week</span>
    <span><i style="border-style:dotted;border-color:#c0392b;border-width:2px"></i>submitted</span>
    <span><i style="border-style:dashed;border-color:#555"></i>blocked</span>
    <span><span style="display:inline-block;width:14px;border-top:1.5px solid #8a7a5a;vertical-align:middle;margin-right:4px"></span>chain — storms &amp; full units, step to step</span>
    <span><i style="background:#e4e0d8;border-color:#a09880"></i>out — time off, holidays (short weeks shaded)</span>
    <span style="color:#c0392b">┆ today</span><span style="color:var(--green)">▶ next opening</span></div>`;
  return renderReview() + `<div class="sch-panel">
    <div class="sch-panel-head"><b>${title}</b><span>board as of ${esc(d.leadTimesAsOf || "?")} · today ${esc(d.today || "")}</span></div>
    <div class="sch-tl-scroll">${svg.join("")}</div>${legend}
    <div class="sch-note">${note}</div></div>` + renderOutModal();
}

// ── Out row: time off blocks Geoff adds on the board ──────────────────
let localOut = null;  // boards/timeoff entries loaded this session (newer than the shipped list)
function outEntries() {
  const shipped = (dash?.out || []).filter((e) => e.source !== "board");
  const board = localOut !== null ? localOut : (dash?.out || []).filter((e) => e.source === "board");
  return shipped.concat(board.map((e) => ({ ...e, source: "board" })));
}
function renderOutModal() {
  const people = (crew || []).filter((c) => c.active !== false).map((c) => `<option value="${esc(c.initials)}">${esc(c.initials)} — ${esc(c.name || "")}</option>`).join("");
  return `<div class="sch-overlay" id="schModalOut" data-act="sch-overlay"><div class="sch-modal">
    <h3>Time off</h3>
    <label>Who</label><select id="outWho"><option value="SHOP">Shop closed — everyone</option>${people}</select>
    <label>First day</label><input type="date" id="outStart">
    <label>Last day</label><input type="date" id="outEnd">
    <label>Note</label><input id="outNote" placeholder="vacation, dentist, holiday…">
    <p class="sch-modal-text">Cuts that lane's hours for the week; the OS repacks around it on the next schedule check.</p>
    <div class="sch-modal-btns"><button data-act="sch-out-cancel">Cancel</button><button class="primary" data-act="sch-out-save">Save</button></div></div></div>`;
}
function openOutModal() { const m = $("schModalOut"); if (!m) return; $("outStart").value = key(new Date()); $("outEnd").value = ""; $("outNote").value = ""; m.classList.add("open"); }
function closeOutModal() { const m = $("schModalOut"); if (m) m.classList.remove("open"); }
async function saveOutModal() {
  const who = $("outWho").value, start = $("outStart").value, end = $("outEnd").value || start, note = $("outNote").value.trim();
  if (!start) { $("outStart").focus(); return; }
  if (end < start) { toast("Last day is before the first day", true); return; }
  const entry = { id: uid(), who, start, end, note, by: auth.currentUser?.email || "", at: new Date().toISOString() };
  try {
    await addTimeOff(entry);
    if (localOut === null) localOut = await loadTimeOff(); else localOut.push(entry);
    closeOutModal(); render();
    toast(`${who === "SHOP" ? "Shop closed" : who + " out"} ${start}${end !== start ? " – " + end : ""} saved. The board shortens that week on the next schedule check.`);
  } catch (err) { toast(`Couldn't save: ${err.message || err}`, true); }
}
async function removeOut(id) {
  if (localOut === null) localOut = await loadTimeOff();
  const entry = localOut.find((e) => e.id === id); if (!entry) return;
  try { await removeTimeOff(entry); localOut = localOut.filter((e) => e.id !== id); render(); toast("Block removed."); }
  catch (err) { toast(`Couldn't remove: ${err.message || err}`, true); }
}

// ── Review: what the OS said about the board Geoff last submitted ────
function renderReview() {
  const r = dash?.review; if (!r || !r.text) return "";
  const stale = dash.committedAt && r.committedAt && dash.committedAt > r.committedAt;
  const html = String(r.text).split("\n").map((ln) => {
    const t = esc(ln).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/_(.+?)_$/g, "<i>$1</i>");
    if (ln.startsWith("## ")) return `<h4>${t.slice(3)}</h4>`;
    if (ln.startsWith("  → ")) return `<div class="rv-fix">→ ${t.slice(4)}</div>`;
    if (ln.startsWith("- ")) return `<div class="rv-item">${t.slice(2)}</div>`;
    return ln.trim() ? `<div>${t}</div>` : "";
  }).join("");
  const c = r.counts || {};
  return `<details class="sch-panel sch-review"${(c.breaks || c.reds) ? " open" : ""}>
    <summary><b>Review of your last submit</b> · ${esc(stampShort(r.at))}${stale ? ` · <span class="rv-stale">board changed since — submit again for a fresh one</span>` : ""}
      <span class="rv-counts">${c.yours ?? 0} moves · ${c.fallout ?? 0} knock-ons · ${c.breaks ?? 0} problems · ${c.reds ?? 0} emails owed</span></summary>
    <div class="rv-body">${html}</div></details>`;
}

// ── Revert / Clear: pins are the only thing Geoff authors ─────────────
const PIN_FIELDS = ["site", "fab", "measure", "fit", "glazing", "install"].flatMap((p) => {
  const f = pinFields(p); return [f.week, f.lane, f.week + "By", f.week + "At"];
});
function anyPins() { return jobs.some((j) => PIN_FIELDS.some((f) => j[f])); }
function pinsDifferFromShipped() {
  const shipped = dash?.shippedPins; if (!shipped) return anyPins();
  return jobs.some((j) => { const t = shipped[j.id] || {}; return PIN_FIELDS.some((f) => (j[f] || null) !== (t[f] || null)); });
}
async function setPinsTo(targetFor, doneMsg) {
  let n = 0;
  for (const j of jobs) {
    const t = targetFor(j) || {}; const patch = {};
    PIN_FIELDS.forEach((f) => { if ((j[f] || null) !== (t[f] || null)) patch[f] = t[f] || null; });
    if (!Object.keys(patch).length) continue;
    await saveJob(j.id, patch); Object.assign(j, patch); n++;
  }
  dash = await loadDashboard(); overlayPins(); render();
  toast(n ? `${doneMsg} (${n} job${n > 1 ? "s" : ""}). The OS repacks on the next schedule check.` : "Nothing to change.");
}
function revertBoard() {
  if (!confirm("Put every pin back the way the OS last shipped the board?")) return;
  const shipped = dash?.shippedPins || {};
  setPinsTo((j) => shipped[j.id], "Reverted to the last shipped board").catch((e) => toast(`Couldn't revert: ${e.message || e}`, true));
}
function clearPins() {
  if (!confirm("Clear every pin? Contract and promised weeks stay — they live in the job folders.")) return;
  setPinsTo(() => ({}), "Pins cleared").catch((e) => toast(`Couldn't clear: ${e.message || e}`, true));
}

/** A timeline bar's slug → a pm_projects id, by osFolder then by last name. */
function resolveJobId(slug, label) {
  const s = String(slug || "").toLowerCase();
  if (s) {
    const byFolder = jobs.find((j) => { const f = String(j.osFolder || "").toLowerCase().replace(/\/+$/, ""); return f && (f === s || f.endsWith("/" + s) || f.split("/").pop() === s); });
    if (byFolder) return byFolder.id;
  }
  const last = (s.split("-")[0] || String(label || "").split(/[\s,(]/)[0]).toLowerCase();
  const pool = liveJobs().concat(jobs);
  const byName = last && pool.find((j) => String(j.clientLastName || "").trim().toLowerCase() === last);
  return byName ? byName.id : null;
}

// ── Crew: two weeks × roster ─────────────────────────────────────────
function renderCrew() {
  const chips = LEGEND.map(([t, label]) => `<button class="sch-chip sch-chip-${t}${typeFilters.has(t) ? " active" : ""}" data-act="sch-filter" data-type="${t}">${label}</button>`).join("");
  const strip = `<div class="sch-strip">
      ${renderMiniCal()}
      <div class="sch-strip-space"></div>
      <div class="sch-chips">${chips}</div>
      <button class="sch-tool" data-act="sch-toggle-jobs">${showJobStrip ? "Hide jobs" : "Show jobs"}</button>
      <span class="sch-keys">V ←→ · ⌘C copy</span>
    </div>`;
  const emps = rowEmps();
  const weeks = [["Week 1", weekDates(anchorMonday)], ["Week 2", weekDates(addDays(anchorMonday, 7))]];
  const body = emps.length
    ? weeks.map(([label, dates]) => renderWeek(label, dates, emps)).join("")
    : `<div class="sch-empty">No crew on file — the OS writes the roster to settings/crew from eps/scheduling.yaml.</div>`;
  return strip + `<div class="sch-board">${body}</div>${renderModals()}`;
}

function renderMiniCal() {
  const winStart = key(anchorMonday), winEnd = key(addDays(anchorMonday, 11));
  const w1 = anchorMonday, w2 = addDays(anchorMonday, 11);
  const months = [[w1.getFullYear(), w1.getMonth()]];
  if (w2.getMonth() !== w1.getMonth() || w2.getFullYear() !== w1.getFullYear()) months.push([w2.getFullYear(), w2.getMonth()]);
  return `<div class="sch-minical">` + months.map(([yr, mo]) => {
    const start = mondayOf(new Date(yr, mo, 1));
    let cells = ["M", "T", "W", "T", "F"].map((l) => `<div class="mc-day mc-hdr">${l}</div>`).join("");
    for (let w = 0; w < 5; w++) for (let dd = 0; dd < 5; dd++) {
      const c = addDays(start, w * 7 + dd); const k = key(c);
      if (w === 4 && c.getMonth() !== mo) continue;
      cells += `<div class="mc-day${c.getMonth() !== mo ? " other" : ""}${isToday(c) ? " today" : ""}${k >= winStart && k <= winEnd ? " in" : ""}" data-act="sch-goto" data-day="${k}">${c.getDate()}</div>`;
    }
    return `<div><div class="mc-title">${MONTHS[mo]} ${yr}</div><div class="mc-grid">${cells}</div></div>`;
  }).join("") + `</div>`;
}

function cardsForEmpWeek(emp, dates) {
  const ws = key(dates[0]), we = key(dates[4]);
  return cards.filter((c) => c.emp === emp && c.startDate <= we && c.endDate >= ws && typeFilters.has(filterType(c.type)));
}

function renderWeek(label, dates, emps) {
  const ws = key(dates[0]), we = key(dates[4]);
  const head = `<div class="sch-corner"></div>` + dates.map((d, i) =>
    `<div class="sch-dayhead${isToday(d) ? " is-today" : ""}"><div class="dn">${DAYS[i]}</div><div class="dd">${fmt(d)}</div></div>`).join("");
  const rows = emps.map((emp, ei) => {
    const last = ei === emps.length - 1;
    const stack = [0, 0, 0, 0, 0], cardHtml = [[], [], [], [], []];
    cardsForEmpWeek(emp, dates).forEach((card) => {
      const vs = card.startDate < ws ? ws : card.startDate, ve = card.endDate > we ? we : card.endDate;
      let s = dates.findIndex((d) => key(d) === vs), e = dates.findIndex((d) => key(d) === ve);
      if (s < 0) s = 0; if (e < 0) e = 4; if (e < s) e = s;
      const top = 4 + Math.max(...stack.slice(s, e + 1));
      cardHtml[s].push(renderCard(card, s, e, top));
      for (let c = s; c <= e; c++) stack[c] = top - 4 + CARD_H + CARD_GAP;
    });
    const cells = dates.map((d, i) => {
      const minH = Math.max(CELL_MIN_H, stack[i] + 8);
      return `<div class="sch-cell${isToday(d) ? " is-today" : ""}${last ? " last" : ""}" data-act="sch-cell" data-emp="${esc(emp)}" data-day="${key(d)}" style="min-height:${minH}px">${cardHtml[i].join("")}</div>`;
    }).join("");
    return `<div class="sch-rowlabel${last ? " last" : ""}" title="${esc(empName(emp))}">${esc(emp)}</div>${cells}`;
  }).join("");
  return `<div class="sch-week"><div class="sch-weeklabel">${label}</div>${renderJobStrip(dates)}<div class="sch-grid">${head}${rows}</div></div>`;
}

function renderCard(card, s, e, top) {
  const t = displayType(card.type), n = e - s + 1;
  const dur = daysBetween(card.startDate, card.endDate);
  const span = dur > 0 ? `<span class="scard-span">${dur + 1}d</span>` : "";
  const style = `top:${top}px;width:calc(${n * 100}% - ${8 + (n - 1)}px)`;
  const btns = (t === "off" ? "" : `<button class="scard-btn" data-act="sch-copy" title="Copy">⧉</button>`)
    + `<button class="scard-btn" data-act="sch-edit" title="Edit">✎</button><button class="scard-btn" data-act="sch-del" title="Remove">✕</button>`;
  const name = t === "off" ? "Off" : `${card.priorityId ? "#" + esc(card.priorityId) + " " : ""}${esc(card.client || "")}`;
  const desc = t !== "off" && card.desc ? `<span class="scard-desc">${esc(card.desc)}</span>` : "";
  return `<div class="scard scard-${t}" data-id="${esc(card.id)}" style="${style}" title="${esc(empName(card.emp))} · ${esc(TYPES[t] || t)} · ${esc(card.startDate)} → ${esc(card.endDate)}">
    <span class="scard-name">${name}</span>${desc}${span}<div class="scard-btns">${btns}</div></div>`;
}

/** Group this week's client cards into one bar per client (5-day gap tolerance). */
function jobsForWeek(dates) {
  const ws = key(dates[0]), we = key(dates[4]), groups = {};
  cards.forEach((c) => {
    if (c.type === "off" || !c.client || c.endDate < ws || c.startDate > we || !typeFilters.has(filterType(c.type))) return;
    (groups[c.client] = groups[c.client] || []).push(c);
  });
  const out = [];
  Object.entries(groups).forEach(([client, list]) => {
    list.sort((a, b) => a.startDate.localeCompare(b.startDate));
    let job = null;
    list.forEach((c) => {
      if (job && c.startDate <= key(addDays(fromKey(job.endDate), 5))) { if (c.endDate > job.endDate) job.endDate = c.endDate; }
      else { if (job) out.push(job); job = { client, startDate: c.startDate, endDate: c.endDate }; }
    });
    if (job) out.push(job);
  });
  return out.sort((a, b) => a.startDate.localeCompare(b.startDate));
}

function renderJobStrip(dates) {
  if (!showJobStrip) return "";
  const list = jobsForWeek(dates); if (!list.length) return "";
  const ws = key(dates[0]), we = key(dates[4]), rows = [];
  const bars = list.map((job) => {
    const cs = job.startDate < ws ? ws : job.startDate, ce = job.endDate > we ? we : job.endDate;
    let s = -1, e = -1;
    dates.forEach((d, i) => { const k = key(d); if (s < 0 && k >= cs) s = i; if (k <= ce) e = i; });
    if (s < 0) s = 0; if (e < 0) e = 4;
    let r = rows.findIndex((end) => end < s); if (r < 0) { r = rows.length; rows.push(e); } else rows[r] = e;
    const sel = selectedJobBar && selectedJobBar.client === job.client && selectedJobBar.startDate === job.startDate;
    return `<div class="sch-jobbar${sel ? " selected" : ""}" style="grid-column:${s + 1} / ${e + 2};grid-row:${r + 1}" data-act="sch-jobbar" data-client="${esc(job.client)}" data-start="${job.startDate}" data-end="${job.endDate}"><span>${esc(job.client)}</span></div>`;
  }).join("");
  return `<div class="sch-jobstrip"><div class="sch-jobstrip-label">Jobs</div><div class="sch-jobstrip-cells">${bars}</div></div>`;
}

// ── Modals ───────────────────────────────────────────────────────────
function renderModals() {
  return `<div class="sch-overlay" id="schModalCard" data-act="sch-overlay"><div class="sch-modal" id="schModalCardBox"></div></div>
    <div class="sch-overlay" id="schModalDel" data-act="sch-overlay"><div class="sch-modal">
      <h3>Remove assignment?</h3><p class="sch-modal-text" id="schDelMsg"></p>
      <div class="sch-modal-btns"><button data-act="sch-del-cancel">Cancel</button><button class="danger" data-act="sch-del-confirm">Remove</button></div></div></div>`;
}

function openCardModal(card, ctx) {
  modal = card
    ? { id: card.id, emp: card.emp, type: displayType(card.type), client: card.client || "", desc: card.desc || "", start: card.startDate, end: card.endDate, jobId: card.jobId || null, priorityId: card.priorityId || null }
    : { id: null, emp: ctx.emp, type: "fab", client: "", desc: "", start: ctx.day, end: ctx.day, jobId: null, priorityId: null };
  const emps = rowEmps(); if (modal.emp && !emps.includes(modal.emp)) emps.push(modal.emp);
  const empOpts = emps.map((e) => `<option value="${esc(e)}"${e === modal.emp ? " selected" : ""}>${esc(e)}${empName(e) !== e ? " — " + esc(empName(e)) : ""}</option>`).join("");
  const typeBtns = Object.entries(TYPES).map(([t, label]) => `<button class="sch-type-btn${modal.type === t ? " active-" + t : ""}" data-act="sch-type" data-type="${t}">${label}</button>`).join("");
  const jobOpts = liveJobs().map((j) => `<option value="${esc(j.clientLastName || "")}">${esc((j.priority ? "#" + j.priority + " · " : "") + (j.clientFullName || "") + (statusOf(j) === "production" ? " · in production" : ""))}</option>`).join("")
    + prodClients.filter((n) => !jobByLastName(n)).map((n) => `<option value="${esc(n)}"></option>`).join("");
  const hide = modal.type === "off" ? " hidden" : "";
  $("schModalCardBox").innerHTML = `
    <h3>${modal.id ? "Edit assignment" : "Add assignment"}</h3>
    <label>Employee</label><select id="schEmp">${empOpts}</select>
    <label>Type</label><div class="sch-type-btns">${typeBtns}</div>
    <div class="sch-client-row${hide}"><label>Client</label>
      <input type="text" id="schClient" list="schJobList" autocomplete="off" placeholder="Client name" value="${esc(modal.client)}"><datalist id="schJobList">${jobOpts}</datalist>
      <div class="sch-hint" id="schJobHint">${jobHint()}</div></div>
    <div class="sch-client-row${hide}"><label>Work description</label><input type="text" id="schDesc" autocomplete="off" placeholder="e.g. glazing sashes, site measure" value="${esc(modal.desc)}"></div>
    <label>Start date</label><input type="date" id="schStart" value="${modal.start}">
    <label>End date</label><input type="date" id="schEnd" value="${modal.end}">
    <div class="sch-modal-btns"><button data-act="sch-card-cancel">Cancel</button><button class="primary" data-act="sch-card-save">Save</button></div>`;
  $("schModalCard").classList.add("open");
  setTimeout(() => { const f = $(modal.type === "off" ? "schStart" : "schClient"); if (f) f.focus(); }, 40);
}

function jobHint() {
  const j = jobById(modal.jobId) || jobByLastName(modal.client);
  if (j) return `Linked to ${esc(j.clientFullName || j.clientLastName)}${j.priority ? " · priority #" + esc(j.priority) : ""} (${esc(j.id)})`;
  return modal.client ? "Not a live job — saved as a plain name" : "Pick a live job or type any name";
}

function closeCardModal() { const m = $("schModalCard"); if (m) m.classList.remove("open"); modal = null; }

function setModalType(t) {
  if (!modal) return; modal.type = t;
  document.querySelectorAll("#schModalCardBox .sch-type-btn").forEach((b) => { b.className = "sch-type-btn" + (b.dataset.type === t ? " active-" + t : ""); });
  document.querySelectorAll("#schModalCardBox .sch-client-row").forEach((r) => r.classList.toggle("hidden", t === "off"));
}

/** Client field changed: link the job, and size the card from its hours budget if the dates are untouched. */
function onClientChanged() {
  if (!modal) return;
  modal.client = $("schClient").value.trim();
  const j = jobByLastName(modal.client);
  modal.jobId = j ? j.id : null;
  modal.priorityId = j ? (parseInt(j.priority, 10) || null) : modal.priorityId;
  $("schJobHint").innerHTML = jobHint();
  if (!j || modal.id) return;
  const start = $("schStart").value; if (!start || $("schEnd").value !== start) return;
  const t = modal.type; if (t !== "fab" && t !== "resto") return;
  const budget = j.hoursBudget || [];
  const pick = (kind) => budget.filter((r) => r.type === kind || (!r.type && r.scope && r.scope.toLowerCase().startsWith(kind))).reduce((s, r) => s + (parseFloat(r.total) || 0), 0);
  const hours = t === "fab" ? pick("fab") * 0.5 : pick("resto");
  if (hours > 0) { const days = Math.ceil(hours / 8); $("schEnd").value = addBizDays(start, days - 1); toast(`Duration set from the hours budget: ${days} day${days !== 1 ? "s" : ""} (${hours} h)`); }
}

function saveCardModal() {
  if (!modal) return;
  const emp = $("schEmp").value, type = modal.type;
  const client = $("schClient").value.trim(), desc = $("schDesc").value.trim();
  const start = $("schStart").value; let end = $("schEnd").value;
  if (!start) { $("schStart").focus(); return; }
  if (!end || end < start) end = start;
  if (type !== "off" && !client) { $("schClient").focus(); return; }
  const j = type === "off" ? null : (jobByLastName(client) || (modal.jobId && jobById(modal.jobId)) || null);
  const jobId = j && String(j.clientLastName || "").trim().toLowerCase() === client.toLowerCase() ? j.id : null;
  const priorityId = jobId ? (parseInt(j.priority, 10) || null) : (type === "off" ? null : modal.priorityId);
  const patch = { emp, type, client: type === "off" ? "" : client, desc: type === "off" ? "" : desc, startDate: start, endDate: end, priorityId, jobId };
  if (modal.id) {
    const c = cards.find((x) => x.id === modal.id);
    if (c) { Object.assign(c, patch); toast("Assignment updated."); }
  } else { cards.push({ id: uid(), ...patch }); toast("Assignment added."); }
  if (client && !prodClients.includes(client)) prodClients.push(client);
  closeCardModal(); scheduleSave(); render();
}

function openDeleteModal(id) {
  const c = cards.find((x) => x.id === id); if (!c) return;
  deleteId = id;
  $("schDelMsg").textContent = `Remove "${c.type === "off" ? "Off" : (c.client || "this assignment")}" for ${c.emp}? This can't be undone.`;
  $("schModalDel").classList.add("open");
}
function closeDeleteModal() { const m = $("schModalDel"); if (m) m.classList.remove("open"); deleteId = null; }
function confirmDelete() {
  if (deleteId) { cards = cards.filter((c) => c.id !== deleteId); scheduleSave(); toast("Assignment removed."); }
  closeDeleteModal(); render();
}

// ── Copy / paste ─────────────────────────────────────────────────────
function copyCard(id) {
  const c = cards.find((x) => x.id === id); if (!c) return;
  copiedCard = { ...c }; copiedJobBar = null; selectedJobBar = null;
  $("schedWrap").classList.add("paste-ready");
  toast(`"${c.type === "off" ? "Off" : c.client}" copied — click a cell to paste. Esc cancels.`);
}
function clearSelection() {
  copiedCard = null; copiedJobBar = null; selectedJobBar = null;
  const w = $("schedWrap"); if (w) w.classList.remove("paste-ready");
  document.querySelectorAll(".sch-jobbar.selected").forEach((b) => b.classList.remove("selected"));
}
function pasteTo(emp, day) {
  if (copiedJobBar) {
    const dur = daysBetween(copiedJobBar.startDate, copiedJobBar.endDate);
    cards.push({ id: uid(), emp, type: copiedJobBar.type, client: copiedJobBar.client, desc: copiedJobBar.desc || "", startDate: day, endDate: key(addDays(fromKey(day), dur)), priorityId: copiedJobBar.priorityId || null, jobId: copiedJobBar.jobId || null });
    toast(`Pasted "${copiedJobBar.client}" for ${emp}.`);
    clearSelection(); scheduleSave(); render(); return;
  }
  if (copiedCard) {
    const dur = daysBetween(copiedCard.startDate, copiedCard.endDate);
    const c = { ...copiedCard, id: uid(), emp, startDate: day, endDate: key(addDays(fromKey(day), dur)) };
    cards.push(c); scheduleSave(); render();
    toast(`Pasted "${c.type === "off" ? "Off" : c.client}" for ${emp}. Click another cell to paste again, Esc to stop.`);
  }
}
function selectJobBar(el) {
  const client = el.dataset.client, ws = el.dataset.start, we = el.dataset.end;
  const matching = cards.filter((c) => c.client === client && c.type !== "off" && c.startDate <= we && c.endDate >= ws);
  copiedCard = null; copiedJobBar = null;
  selectedJobBar = {
    client, startDate: ws, endDate: we,
    type: matching.length ? filterType(matching[0].type) : "fab",
    desc: matching.map((c) => c.desc).find((d) => d) || "",
    priorityId: matching.map((c) => c.priorityId).find((p) => p) || null,
    jobId: matching.map((c) => c.jobId).find((p) => p) || null,
  };
  document.querySelectorAll(".sch-jobbar.selected").forEach((b) => b.classList.remove("selected"));
  el.classList.add("selected"); $("schedWrap").classList.remove("paste-ready");
  toast(`"${client}" selected — ⌘C / Ctrl+C to copy the job, then click a cell.`);
}

// ── Drag a card between cells ────────────────────────────────────────
function startDrag(el, e) {
  const card = cards.find((c) => c.id === el.dataset.id); if (!card) return;
  e.preventDefault();
  const sx = e.clientX, sy = e.clientY; let moved = false, hl = null;
  const cellAt = (x, y) => { el.style.display = "none"; const hit = document.elementFromPoint(x, y); el.style.display = ""; return hit ? hit.closest(".sch-cell") : null; };
  const grabCell = cellAt(sx, sy); const grabDate = grabCell ? grabCell.dataset.day : card.startDate;
  el.classList.add("dragging");
  const onMove = (m) => {
    const dx = m.clientX - sx, dy = m.clientY - sy;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
    el.style.transform = `translate(${dx}px,${dy}px)`;
    if (hl) hl.classList.remove("drag-over");
    hl = cellAt(m.clientX, m.clientY); if (hl) hl.classList.add("drag-over");
  };
  const onUp = (m) => {
    document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp);
    if (hl) hl.classList.remove("drag-over");
    el.classList.remove("dragging"); el.style.transform = "";
    if (!moved) return;
    dragEndedAt = Date.now();
    const drop = cellAt(m.clientX, m.clientY);
    if (!drop || !drop.dataset.day || !drop.dataset.emp) return;
    const shift = daysBetween(/^\d{4}-\d{2}-\d{2}$/.test(grabDate) ? grabDate : card.startDate, drop.dataset.day);
    if (shift === 0 && drop.dataset.emp === card.emp) return;
    card.emp = drop.dataset.emp;
    card.startDate = key(addDays(fromKey(card.startDate), shift));
    card.endDate = key(addDays(fromKey(card.endDate), shift));
    scheduleSave(); render();
  };
  document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
}

// ── Forecast: drag a bar to pin its job to a week ────────────────────
function startBarDrag(g, e) {
  const bar = dash && dash.timeline ? dash.timeline[+g.dataset.bar] : null;
  if (!bar || !tlGeom) return;
  e.preventDefault();
  const sx = e.clientX, sy = e.clientY; let moved = false, weeks = 0, lane = bar.lane, hl = null;
  const svgEl = g.closest("svg"), svgTop = svgEl.getBoundingClientRect().top;
  const day = 86400000, at = (s) => new Date(s + "T00:00:00");
  const startWeek = Math.round((at(bar.start) - tlGeom.t0) / (7 * day));
  const minWeeks = -startWeek; // never before the first column (this week)
  const laneAt = (clientY) => { const y = clientY - svgTop; const ln = (tlGeom.lanes || []).find((l) => y >= l.y0 && y < l.y1); return ln ? ln.k : bar.lane; };
  g.classList.add("dragging");
  const onMove = (m) => {
    const dx = m.clientX - sx, dy = m.clientY - sy;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
    weeks = Math.max(minWeeks, Math.round(dx / tlGeom.W));
    lane = laneAt(m.clientY);
    g.setAttribute("transform", `translate(${weeks * tlGeom.W},${dy})`);
    if (hl) hl.setAttribute("visibility", "hidden");
    hl = lane !== bar.lane ? svgEl.querySelector(`.lane-drop[data-lane="${lane}"]`) : null;
    if (hl) hl.setAttribute("visibility", "visible");
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp);
    g.classList.remove("dragging"); g.removeAttribute("transform");
    if (hl) hl.setAttribute("visibility", "hidden");
    if (!moved) return;
    dragEndedAt = Date.now();
    if (weeks === 0 && lane === bar.lane) return;
    const week = key(mondayOf(new Date(at(bar.start).getTime() + weeks * 7 * day)));
    pinBar(bar, week, lane);
  };
  document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
}

/** Save the pin on the job, move the bar on screen, and say what happens next. */
const LANE_WORDS = { restoration: "restoration", fabrication: "fabrication", filler: "onesie-twosie" };
/** Which job fields a bar's pin lives in: site / fab twin / measure twin. */
function pinFields(part) {
  // site → pinnedWeek/pinnedLane; any twin or chain link (fab, measure, fit,
  // glazing, install) → pinned<Part>Week / pinned<Part>Lane.
  const stem = !part || part === "site" ? "pinned" : "pinned" + part[0].toUpperCase() + part.slice(1);
  return { week: stem + "Week", lane: stem + "Lane" };
}
async function pinBar(bar, week, lane) {
  const id = resolveJobId(bar.slug, bar.label);
  if (!id) { toast(`No job in the app matches "${bar.label}" — add it on the Jobs tab first`, true); return; }
  lane = lane || bar.lane;
  const { week: field, lane: laneField } = pinFields(bar.part);
  const prev = { start: bar.start, lane: bar.lane, pinned: bar.pinned, anchored: bar.anchored, localPin: bar.localPin, conflict: bar.conflict };
  const laneChanged = lane !== bar.lane;
  const stamp = new Date().toISOString();
  bar.start = week; bar.lane = lane; bar.pinned = week; bar.anchored = true; bar.localPin = true;
  bar.conflict = bar.writtenWeek && bar.writtenWeek !== week ? bar.writtenWeek : "";
  const job = jobById(id); if (job) job[field + "At"] = stamp;
  render();
  try {
    await saveJob(id, { [field]: week, [laneField]: lane, [field + "By"]: "board", [field + "At"]: stamp });
    toast(bar.conflict
      ? `${bar.label} moved off the week the client was told (${bar.conflict}). Red until you press Submit board.`
      : `${bar.label} pinned to week of ${week}${laneChanged ? " as " + LANE_WORDS[lane] : ""}. The OS repacks the others on the next schedule check.`);
  } catch (err) {
    Object.assign(bar, prev); render();
    toast(`Couldn't save the pin: ${err.message || err}`, true);
  }
}

async function unpinBar(idx) {
  const bar = dash && dash.timeline ? dash.timeline[idx] : null; if (!bar) return;
  const id = resolveJobId(bar.slug, bar.label); if (!id) return;
  const { week: field, lane: laneField } = pinFields(bar.part);
  bar.pinned = ""; bar.anchored = !!bar.writtenWeek; bar.conflict = ""; bar.localPin = true;
  if (bar.writtenWeek) bar.start = bar.writtenWeek;
  const job = jobById(id); if (job) job[field + "At"] = null;
  render();
  try {
    await saveJob(id, { [field]: null, [laneField]: null, [field + "By"]: null, [field + "At"]: null });
    toast(`${bar.label} unpinned — it floats again after the next schedule check.`);
  } catch (err) { toast(`Couldn't unpin: ${err.message || err}`, true); }
}

// ── Pins over the timeline ───────────────────────────────────────────
// boards/dashboard is the OS's last schedule check. Geoff's pins live on
// the jobs and may be newer, so every load lays them over the bars: the
// board always shows where he put things, whether or not the OS has run.
function overlayPins() {
  (dash?.timeline || []).forEach((b) => {
    const j = jobById(resolveJobId(b.slug, b.label)); if (!j) return;
    const f = pinFields(b.part);
    const week = j[f.week], lane = j[f.lane];
    if (week) {
      b.start = week; b.pinned = week; b.anchored = true;
      if (lane) b.lane = lane;
      b.conflict = b.writtenWeek && b.writtenWeek !== week ? b.writtenWeek : "";
    } else if (b.pinned) {
      // The OS still thinks it is pinned but the job says no: it was unpinned since the last check.
      b.pinned = ""; b.conflict = ""; b.anchored = !!b.writtenWeek;
      if (b.writtenWeek) b.start = b.writtenWeek;
    }
  });
}

// ── Submit: the board is a draft until Geoff commits it ──────────────
function pinStampOf(b) {
  const id = resolveJobId(b.slug, b.label); const j = jobById(id); if (!j) return "";
  return j[pinFields(b.part).week + "At"] || "";
}
/** A pin is draft when it was made after the last submit (or there never was one). */
function pinIsDraft(b) {
  const at = pinStampOf(b); if (!at) return false;
  return !dash?.committedAt || at > dash.committedAt;
}
function boardIsDraft() { return (dash?.timeline || []).some((b) => b.pinned && pinIsDraft(b)); }
function stampShort(iso) { const d = new Date(iso); return isNaN(d) ? "" : `${d.getMonth() + 1}/${d.getDate()} ${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")}${d.getHours() < 12 ? "am" : "pm"}`; }
async function submitBoard() {
  try {
    const who = auth.currentUser?.email || "";
    const at = await commitBoard(who);
    dash.committedAt = at; dash.committedBy = who;
    const reds = (dash.timeline || []).filter((b) => b.pinned && b.conflict).length;
    render();
    toast(reds ? `Board submitted. Ask the OS to "review my board" — it writes up the fallout and drafts ${reds} client email${reds > 1 ? "s" : ""}.` : `Board submitted. Ask the OS to "review my board" for the write-up.`);
  } catch (err) { toast(`Couldn't submit: ${err.message || err}`, true); }
}

// ── Navigation ───────────────────────────────────────────────────────
function setView(v) { view = v; if (v === "crew") focus = null; render(); }
function goWeek(delta) { anchorMonday = addDays(anchorMonday, delta * 7); render(); }
function openJobFromBar(el) {
  const id = resolveJobId(el.dataset.slug, el.dataset.label);
  if (!id) { toast(`No job in the app matches "${el.dataset.label}" yet`, true); return; }
  document.dispatchEvent(new CustomEvent("eps:navigate", { detail: { tab: "jobs", jobId: id } }));
}

// ═════════════════════════════════════════════════════════════════════
// EVENTS — one click listener (header buttons live outside <main>), one keydown, one mousedown
// ═════════════════════════════════════════════════════════════════════
function wireEvents() {
  document.addEventListener("click", (e) => {
    if (!isMounted()) return;
    const el = e.target.closest("[data-act^='sch-']"); if (!el) return;
    const act = el.dataset.act;
    const cardEl = e.target.closest(".scard");
    switch (act) {
      case "sch-view": setView(el.dataset.view); break;
      case "sch-prev": goWeek(-1); break;
      case "sch-next": goWeek(1); break;
      case "sch-today": anchorMonday = mondayOf(new Date()); render(); break;
      case "sch-goto": anchorMonday = mondayOf(fromKey(el.dataset.day)); render(); break;
      case "sch-print": window.print(); break;
      case "sch-filter": { const t = el.dataset.type; typeFilters.has(t) ? typeFilters.delete(t) : typeFilters.add(t); render(); break; }
      case "sch-toggle-jobs": showJobStrip = !showJobStrip; render(); break;
      case "sch-open-job": if (Date.now() - dragEndedAt < 300) break; openJobFromBar(el); break;
      case "sch-unpin": e.stopPropagation(); unpinBar(+el.dataset.bar); break;
      case "sch-submit": submitBoard(); break;
      case "sch-revert": revertBoard(); break;
      case "sch-out-add": openOutModal(); break;
      case "sch-out-cancel": closeOutModal(); break;
      case "sch-out-save": saveOutModal(); break;
      case "sch-out-remove": e.stopPropagation(); removeOut(el.dataset.out); break;
      case "sch-clear": clearPins(); break;
      case "sch-jobbar": if (Date.now() - dragEndedAt < 300) break; e.stopPropagation(); selectJobBar(el); break;
      case "sch-copy": e.stopPropagation(); copyCard(cardEl.dataset.id); break;
      case "sch-edit": e.stopPropagation(); openCardModal(cards.find((c) => c.id === cardEl.dataset.id)); break;
      case "sch-del": e.stopPropagation(); openDeleteModal(cardEl.dataset.id); break;
      case "sch-cell": {
        if (Date.now() - dragEndedAt < 300) break;
        if (cardEl) {
          if (copiedCard || copiedJobBar) pasteTo(el.dataset.emp, el.dataset.day);
          else openCardModal(cards.find((c) => c.id === cardEl.dataset.id));
          break;
        }
        if (copiedCard || copiedJobBar) pasteTo(el.dataset.emp, el.dataset.day);
        else openCardModal(null, { emp: el.dataset.emp, day: el.dataset.day });
        break;
      }
      case "sch-type": setModalType(el.dataset.type); break;
      case "sch-card-cancel": closeCardModal(); break;
      case "sch-card-save": saveCardModal(); break;
      case "sch-del-cancel": closeDeleteModal(); break;
      case "sch-del-confirm": confirmDelete(); break;
      case "sch-overlay": if (e.target === el) { closeCardModal(); closeDeleteModal(); closeOutModal(); } break;
    }
  });

  document.addEventListener("mousedown", (e) => {
    if (!isMounted() || e.button !== 0) return;
    if (view === "forecast") {
      const bar = e.target.closest(".tl-bar"); if (!bar || e.target.closest(".bar-unpin")) return;
      startBarDrag(bar, e); return;
    }
    if (view !== "crew") return;
    const el = e.target.closest(".scard"); if (!el || e.target.closest(".scard-btn")) return;
    startDrag(el, e);
  });
  document.addEventListener("mouseover", (e) => {
    if (!isMounted()) return;
    const el = e.target.closest(".scard"); hoverCardId = el ? el.dataset.id : null;
  });

  // Modal fields: keep the datalist link fresh, and keep end >= start.
  document.addEventListener("input", (e) => { if (isMounted() && e.target.id === "schClient") onClientChanged(); });
  document.addEventListener("change", (e) => {
    if (!isMounted() || !modal) return;
    if (e.target.id === "schStart" || e.target.id === "schEnd") { const s = $("schStart").value, en = $("schEnd").value; if (en && s && en < s) $("schEnd").value = s; }
  });

  document.addEventListener("keydown", (e) => {
    if (!isMounted()) return;
    const tag = document.activeElement && document.activeElement.tagName;
    const inInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    const cardOpen = $("schModalCard")?.classList.contains("open"), delOpen = $("schModalDel")?.classList.contains("open");

    if (e.key === "Escape") {
      if (cardOpen) { closeCardModal(); return; }
      if (delOpen) { closeDeleteModal(); return; }
      clearSelection(); return;
    }
    if (cardOpen) {
      if (e.key === "Enter" && tag !== "TEXTAREA" && tag !== "SELECT") { e.preventDefault(); saveCardModal(); }
      return;
    }
    if (delOpen) { if (e.key === "Enter") { e.preventDefault(); confirmDelete(); } return; }
    if (view !== "crew") { if (!inInput && (e.key === "v" || e.key === "V")) { e.preventDefault(); setView("crew"); } return; }

    if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C") && !inInput) {
      if (selectedJobBar) {
        copiedJobBar = { ...selectedJobBar }; copiedCard = null;
        $("schedWrap").classList.add("paste-ready");
        toast(`"${selectedJobBar.client}" copied — click a cell to paste.`);
        e.preventDefault(); return;
      }
      if (hoverCardId) { copyCard(hoverCardId); e.preventDefault(); }
      return;
    }
    if (inInput) return;
    if (e.key === "v" || e.key === "V") { e.preventDefault(); setView("forecast"); return; }
    if (e.key === "ArrowLeft") { e.preventDefault(); goWeek(-1); return; }
    if (e.key === "ArrowRight") { e.preventDefault(); goWeek(1); return; }
  });
}
