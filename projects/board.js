// board.js — the Board tab: the shop wall, rebuilt on top of the jobs.
//
// There is no separate board document any more. A card IS a job. Each job
// in pm_projects carries one small field:
//
//   board: { shop: <zoneId|null>, site: <zoneId|null>, shopNote: "", siteNote: "" }
//
// The two lane cards are independent: each has its own note. (An older
// single `note` is shown on both until one of them is edited.)
//
// A job can sit in the Shop lane, the Site lane, both, or neither. Moving a
// card writes that field straight back to Firestore — there is no save
// button on this tab, and nothing is ever "unsaved".
//
// Wiring follows jobs.js: the whole board is one HTML string rendered into
// <main>, and one listener per event type reads data-* attributes. Every
// click action here is prefixed "bd-" so it never collides with the
// document-level listener jobs.js installs.

import { loadJobs, saveJob, money } from "./data.js";

// ── The zones ────────────────────────────────────────────────────────
// Zone ids are stored on jobs and the OS writes them too, so they never
// change. Labels can. Order here is the order they stack on screen.
const SHOP_UPCOMING = [
  { id: "up-shop-measure", label: "Measure / plan" },
  { id: "up-shop-ready",   label: "Ready" },
  { id: "up-shop-hold",    label: "Hold", hold: true },
];
const SHOP_INPROCESS = [
  { id: "ip-shop-bench",   label: "On bench" },
  { id: "ip-shop-glazing", label: "Glazing / paint" },
  { id: "ip-shop-hold",    label: "Hold", hold: true },
];
const SITE_UPCOMING = [
  { id: "up-site-walkthru", label: "Walk thru / plan" },
  { id: "up-site-ready",    label: "Ready" },
  { id: "up-site-hold",     label: "Hold", hold: true },
];
const SITE_INPROCESS = [
  { id: "ip-site-active", label: "Active" },
  { id: "ip-site-limbo",  label: "Limbo" },
  { id: "ip-site-hold",   label: "Hold", hold: true },
];
const FINAL = "final";

/** Which lane a zone id belongs to. "final" belongs to whichever lane the card came from. */
function laneOfZone(zoneId) {
  if (zoneId === FINAL) return null;
  return zoneId.includes("-shop-") ? "shop" : "site";
}
/** The first Upcoming zone of a lane — where "Not placed" cards land. */
const FIRST_ZONE = { shop: "up-shop-measure", site: "up-site-walkthru" };

// ── State ────────────────────────────────────────────────────────────
let root = null;      // the <main> we render into
let jobs = [];        // every job, as loaded
let wired = false;    // listeners attach once, to the first root we get
let dragging = null;  // { id, fromLane } while a card is in the air

// ── Entry points (index.html calls these) ────────────────────────────
export async function mountBoard(el) {
  if (root !== el) { root = el; wired = false; }
  if (!wired) { wireEvents(); wired = true; }
  setHeaderNav(`<button class="btn-header" data-act="bd-print">⎙ Print board</button>`);
  root.innerHTML = `<div class="loading-state">Loading board…</div>`;
  try {
    jobs = await loadJobs();   // loadJobs waits for sign-in itself
  } catch (e) {
    root.innerHTML = `<div class="empty-state"><p>Could not load jobs: ${esc(e.message || e)}</p></div>`;
    return;
  }
  render();
}

/** Every write on this tab is immediate, so there is never anything unsaved. */
export function boardHasUnsaved() { return false; }

// ── Small helpers ────────────────────────────────────────────────────

/** Escape text for HTML — every user-entered string goes through this. */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const $ = (id) => document.getElementById(id);

function toast(msg, isError) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (isError ? " error" : "") + " show";
  setTimeout(() => t.classList.remove("show"), 2800);
}
function setHeaderNav(html) { $("headerNav").innerHTML = html; }

/** Legacy 'active' reads as pre-production, same as jobs.js. */
function statusOf(p) { return p.status === "active" ? "pre-production" : (p.status || "pre-production"); }
function remainingOf(p) {
  const paid = (p.payments || []).reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
  return (p.totalAmount || 0) - paid;
}
/** The job's board field, filled out so callers never test for missing keys. */
function boardOf(p) {
  const b = p.board || {};
  return { shop: b.shop || null, site: b.site || null, note: b.note || "",
           shopNote: b.shopNote ?? b.note ?? "", siteNote: b.siteNote ?? b.note ?? "" };
}
function noteOf(b, lane) { return lane === "shop" ? b.shopNote : b.siteNote; }

// ── Which jobs show where ────────────────────────────────────────────

/** Jobs that belong on the wall at all: working jobs, plus finished ones still parked in Final. */
function boardJobs() {
  return jobs.filter((p) => {
    const s = statusOf(p);
    if (s === "pre-production" || s === "production") return true;
    const b = boardOf(p);
    return b.shop === FINAL || b.site === FINAL;
  });
}
/** Working jobs with no board field yet — they go in the tray until placed. */
function unplacedJobs() {
  return boardJobs().filter((p) => {
    const s = statusOf(p);
    return (s === "pre-production" || s === "production") && !p.board;
  });
}
/** Cards in a given zone for a given lane. Final takes both lanes. */
function jobsInZone(zoneId, lane) {
  const out = [];
  for (const p of boardJobs()) {
    const b = boardOf(p);
    if (lane === "shop" && b.shop === zoneId) out.push({ job: p, lane: "shop" });
    if (lane === "site" && b.site === zoneId) out.push({ job: p, lane: "site" });
  }
  // Alphabetical by last name so the wall reads the same every time.
  return out.sort((a, b) => (a.job.clientLastName || "").localeCompare(b.job.clientLastName || ""));
}

// ── Render ───────────────────────────────────────────────────────────

function render() {
  const unplaced = unplacedJobs();
  const finals = [...jobsInZone(FINAL, "shop"), ...jobsInZone(FINAL, "site")];

  root.innerHTML = `
  <div class="board-wrap">
    ${unplaced.length ? `
    <div class="board-tray">
      <div class="board-tray-label">Not placed</div>
      ${unplaced.map((p) => `
        <div class="tray-item" draggable="true" data-id="${esc(p.id)}" data-lane="tray">
          <span class="tray-name" data-act="bd-open" data-id="${esc(p.id)}">${esc(p.clientLastName || p.id)}</span>
          <span class="tray-est">#${esc(p.estimateNumber || p.id)}</span>
          <button class="tray-btn shop" data-act="bd-place" data-id="${esc(p.id)}" data-lane="shop">→ Shop</button>
          <button class="tray-btn site" data-act="bd-place" data-id="${esc(p.id)}" data-lane="site">→ Site</button>
        </div>`).join("")}
    </div>` : ""}

    <div class="board-grid">
      <div class="board-section" style="grid-column:1/3">Upcoming</div>
      <div></div>
      <div class="board-section" style="grid-column:4/6">In process</div>
      <div></div>
      <div class="board-section">Final</div>

      ${laneColumn("shop", SHOP_UPCOMING)}
      ${laneColumn("site", SITE_UPCOMING)}
      <div class="board-divider"><div class="board-divider-line"></div></div>
      ${laneColumn("shop", SHOP_INPROCESS)}
      ${laneColumn("site", SITE_INPROCESS)}
      <div class="board-divider"><div class="board-divider-line"></div></div>

      <div class="board-col final">
        <div class="col-header neutral">Complete</div>
        <div class="dropzone final-zone" data-zone="${FINAL}" data-lane="any">
          ${finals.map(card).join("")}
        </div>
      </div>
    </div>
  </div>`;
}

/** One lane column: the Shop or Site header, then its zones stacked. */
function laneColumn(lane, zones) {
  return `
  <div class="board-col ${lane}">
    <div class="col-header ${lane}">${lane === "shop" ? "Shop" : "Site"}</div>
    ${zones.map((z) => `
    <div class="zone${z.hold ? " hold" : ""}">
      <div class="zone-label">${esc(z.label)}</div>
      <div class="dropzone" data-zone="${z.id}" data-lane="${lane}">
        ${jobsInZone(z.id, lane).map(card).join("")}
      </div>
    </div>`).join("")}
  </div>`;
}

/** One card. `lane` says which of the job's two board slots this card represents. */
function card({ job: p, lane }) {
  const b = boardOf(p);
  const zone = lane === "shop" ? b.shop : b.site;
  const done = statusOf(p) === "complete" || statusOf(p) === "hold";
  const initials = (p.leadTech || "").trim();
  const remaining = remainingOf(p);
  return `
  <div class="card ${lane}${done ? " done" : ""}" draggable="true" data-id="${esc(p.id)}" data-lane="${lane}">
    <div class="card-body">
      <div class="card-top">
        <span class="card-name" data-act="bd-open" data-id="${esc(p.id)}">${esc(p.clientLastName || p.id)}</span>
        <span class="card-est">#${esc(p.estimateNumber || p.id)}</span>
        ${initials ? `<span class="card-chip">${esc(initials)}</span>` : ""}
        ${zone === FINAL ? `<span class="card-lane-tag ${lane}">${lane}</span>` : ""}
      </div>
      <div class="card-note-row">
        <span class="card-note${noteOf(b, lane) ? "" : " empty"}" data-act="bd-note" data-id="${esc(p.id)}" data-lane="${lane}" title="Edit note">${esc(noteOf(b, lane) || "add note")}</span>
        <button class="card-pencil" data-act="bd-note" data-id="${esc(p.id)}" data-lane="${lane}" title="Edit note">✎</button>
      </div>
      ${p.totalAmount ? `<div class="card-remaining">${money(remaining)} left</div>` : ""}
    </div>
    <button class="card-x" data-act="bd-remove" data-id="${esc(p.id)}" data-lane="${lane}" title="Take off the ${lane} lane">×</button>
  </div>`;
}

// ── Writes ───────────────────────────────────────────────────────────
// Every change goes: update the local job → re-render → write to Firestore.
// If the write fails we put the old value back and say so. The wall never
// waits on the network.

async function writeBoard(id, next) {
  const p = jobs.find((j) => j.id === id); if (!p) return;
  const prev = p.board ? { ...p.board } : null;
  p.board = next;
  render();
  try {
    await saveJob(id, { board: next });
  } catch (e) {
    p.board = prev;
    render();
    toast("Save failed: " + (e.message || e), true);
  }
}

/** Put a job in a zone. Only the lane that zone belongs to changes. */
function moveTo(id, zoneId, fromLane) {
  const p = jobs.find((j) => j.id === id); if (!p) return;
  const b = boardOf(p);
  // Final belongs to whichever lane the card was dragged from. From the
  // tray there is no lane yet, so Final means the site lane.
  const lane = laneOfZone(zoneId) || (fromLane === "tray" ? "site" : fromLane);
  if (b[lane] === zoneId) return;   // dropped where it already was
  b[lane] = zoneId;
  writeBoard(id, b);
}

function removeFromLane(id, lane) {
  const p = jobs.find((j) => j.id === id); if (!p) return;
  const b = boardOf(p);
  b[lane] = null;
  writeBoard(id, b);
}

function saveNote(id, lane, text) {
  const p = jobs.find((j) => j.id === id); if (!p) return;
  const b = boardOf(p);
  text = text.trim();
  if (noteOf(b, lane) === text) { render(); return; }
  if (lane === "shop") b.shopNote = text; else b.siteNote = text;
  writeBoard(id, b);
}

// ── Note editing ─────────────────────────────────────────────────────
// Clicking the note (or its pencil) swaps it for an input. Blur or Enter
// commits; Escape puts the old note back.

function startNoteEdit(id, lane) {
  const cardEl = root.querySelector(`.card[data-id="${CSS.escape(id)}"][data-lane="${lane}"] .card-note-row`);
  if (!cardEl || cardEl.querySelector("input")) return;
  const p = jobs.find((j) => j.id === id); if (!p) return;
  const b = boardOf(p);
  cardEl.innerHTML = `<input class="card-note-input" data-note="${esc(id)}" data-lane="${lane}" value="${esc(noteOf(b, lane))}" placeholder="note" maxlength="80">`;
  const input = cardEl.querySelector("input");
  // The card is draggable; an input inside one cannot select text unless we say so.
  cardEl.closest(".card").setAttribute("draggable", "false");
  input.focus(); input.select();
}

// ── Print ────────────────────────────────────────────────────────────
// The print stylesheet keys off this class on <body>, so only the board
// prints in landscape and the Jobs print rules stay untouched.
function printBoard() {
  document.body.classList.add("print-board");
  const done = () => { document.body.classList.remove("print-board"); window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  window.print();
}

// ── Events ───────────────────────────────────────────────────────────

function wireEvents() {
  // Clicks: anything with data-act. The print button lives in the header,
  // outside <main>, so this one listens on document like jobs.js does.
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]"); if (!el) return;
    const act = el.dataset.act;
    if (!act.startsWith("bd-")) return;          // not ours
    if (act !== "bd-print" && !root.contains(el)) return;   // stale board markup elsewhere
    const id = el.dataset.id;
    switch (act) {
      case "bd-open":
        document.dispatchEvent(new CustomEvent("eps:navigate", { detail: { tab: "jobs", jobId: id } }));
        break;
      case "bd-place": moveTo(id, FIRST_ZONE[el.dataset.lane], el.dataset.lane); break;
      case "bd-remove": removeFromLane(id, el.dataset.lane); break;
      case "bd-note": startNoteEdit(id, el.dataset.lane); break;
      case "bd-print": printBoard(); break;
    }
  });

  // Note input: Enter commits, Escape cancels, leaving the field commits.
  root.addEventListener("keydown", (e) => {
    const input = e.target.closest(".card-note-input"); if (!input) return;
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); input.dataset.cancel = "1"; input.blur(); }
  });
  root.addEventListener("focusout", (e) => {
    const input = e.target.closest(".card-note-input"); if (!input) return;
    if (input.dataset.cancel) { render(); return; }
    saveNote(input.dataset.note, input.dataset.lane, input.value);
  });

  // Drag and drop. The card carries its job id and the lane it was picked
  // up from; the dropzone says which zone (and lane) it represents.
  root.addEventListener("dragstart", (e) => {
    // Cards on the board and items in the "Not placed" tray both drag the same way.
    const c = e.target.closest(".card, .tray-item"); if (!c) return;
    dragging = { id: c.dataset.id, fromLane: c.dataset.lane };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", c.dataset.id);   // Firefox needs some data to start a drag
    c.classList.add("dragging");
  });
  root.addEventListener("dragend", (e) => {
    const c = e.target.closest(".card, .tray-item"); if (c) c.classList.remove("dragging");
    dragging = null;
    root.querySelectorAll(".dropzone.drag-over").forEach((z) => z.classList.remove("drag-over"));
  });
  root.addEventListener("dragover", (e) => {
    const z = e.target.closest(".dropzone"); if (!z || !dragging) return;
    e.preventDefault();                       // this is what makes the zone accept a drop
    e.dataTransfer.dropEffect = "move";
    z.classList.add("drag-over");
  });
  root.addEventListener("dragleave", (e) => {
    const z = e.target.closest(".dropzone"); if (!z) return;
    // dragleave also fires when moving between children of the zone; only clear when really leaving.
    if (!z.contains(e.relatedTarget)) z.classList.remove("drag-over");
  });
  root.addEventListener("drop", (e) => {
    const z = e.target.closest(".dropzone"); if (!z || !dragging) return;
    e.preventDefault();
    z.classList.remove("drag-over");
    const { id, fromLane } = dragging;
    dragging = null;
    // Dropping a Shop card on a Site zone (or vice versa) adds the job to
    // that lane; the card it came from stays put. moveTo works this out
    // from the zone id, so there is nothing special to do here.
    moveTo(id, z.dataset.zone, fromLane);
  });
}
