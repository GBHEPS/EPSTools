// jobs.js — the Jobs tab: the list, one job's detail page, and the new-job form.
//
// How it is wired: every view is rendered as an HTML string into the <main>
// element, and one set of listeners on that element handles clicks and edits
// by reading data-* attributes. That keeps the markup and the behavior next
// to each other without any global functions.

import {
  loadJobs, getJob, saveJob, createJob, deleteJob, loadDashboard,
  loadScheduleCards, saveScheduleCards, money, fmtDate, fmtStamp,
} from "./data.js";

// ── Checklist labels ─────────────────────────────────────────────────
// Keys are stored on each job, so they must never change. Labels can.
export const CHECKLIST_LABELS = {
  preProject: {
    contractSigned: "Contract signed",
    depositReceived: "Deposit received",
    siteAccessConfirmed: "Site access confirmed with client",
    addedToHarvest: "Project added to Harvest",
    hoursBudgetEntered: "Hours budget entered in Harvest",
    addedToStreak: "Project added to Streak pipeline",
    specialRequirementsDocumented: "Special requirements documented",
    leadTimeMaterialsOrdered: "Lead time materials ordered",
    sharePhotos: "Share photos",
  },
  production: {
    shopWorkScheduled: "Shop work scheduled",
    siteWorkScheduled: "Site work scheduled with client",
    materialsReceivedAndStaged: "Materials received and staged",
    crewAssignedAndBriefed: "Crew assigned and briefed",
    workInProgress: "Work in progress",
  },
  closeout: {
    finalWalkthrough: "Final walkthrough with client",
    photosDocumented: "Photos documented",
    punchListCompleted: "Punch list completed",
    postProjectAnalysis: "Post-project analysis completed",
    finalInvoiceSent: "Final invoice sent",
    followUpScheduled: "Follow-up scheduled",
    paymentReceived: "Payment received",
  },
};
const SECTION_TITLES = { preProject: "1. Pre-Project Setup", production: "2. Production", closeout: "3. Completion &amp; Closeout" };
const STATUSES = ["pre-production", "production", "complete", "hold"];
const SCHED_TYPES = { walk: "Walk", fab: "Shop Fab", paint: "Paint/Install", resto: "Resto", off: "Off" };

// ── State ────────────────────────────────────────────────────────────
let root = null;           // the <main> we render into
let jobs = [];             // every job, as loaded
let dash = null;           // boards/dashboard
let filters = new Set(["pre-production", "production"]);
let sortCol = null, sortDir = "asc";
let groupByLead = false;
let printMode = false;
let printSelected = new Set();

let job = null;            // the job open in the detail view
let dirty = false;
let hoursRows = [], suppliesRows = [], paymentRows = [], schedRows = [];
let formHoursRows = [];    // the new-job form's hours table
let tally = { total: 0, count: 0 };   // what the list currently adds up to (shown in the strip)

let _nextId = 1;
const uid = () => _nextId++;

// ── Entry points (index.html calls these) ────────────────────────────
let active = false;   // true only while the Jobs tab is the one on screen
export function unmountJobs() { active = false; }
export function mountJobs(el, opts = {}) {
  active = true;
  if (root !== el) { root = el; wireEvents(); }
  // Another tab (Board, Schedule) can ask for one job straight away.
  if (opts.jobId) openJob(opts.jobId); else showList();
}
export function jobsHasUnsaved() { return dirty; }

window.addEventListener("beforeunload", (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

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

/** Legacy 'active' reads as pre-production everywhere. */
function statusOf(p) { return p.status === "active" ? "pre-production" : (p.status || "pre-production"); }
function statusLabel(s) { return s === "pre-production" ? "Pre-Production" : s.charAt(0).toUpperCase() + s.slice(1); }

function paidTotal(p) { return (p.payments || []).reduce((s, r) => s + (parseFloat(r.amount) || 0), 0); }
function remainingOf(p) { return (p.totalAmount || 0) - paidTotal(p); }

function setHeaderNav(html) { $("headerNav").innerHTML = html; }

function markDirty() {
  dirty = true;
  $("saveBar").classList.add("visible");
  $("saveStatus").textContent = "Unsaved changes";
  const top = $("btnSaveTop"); if (top) top.hidden = false;
}
function clearDirty() {
  dirty = false;
  $("saveBar").classList.remove("visible");
  const top = $("btnSaveTop"); if (top) top.hidden = true;
}

// ═════════════════════════════════════════════════════════════════════
// LIST VIEW
// ═════════════════════════════════════════════════════════════════════

async function showList() {
  job = null;
  clearDirty();
  if (printMode) togglePrintMode();
  setHeaderNav(`<button class="btn-header" id="btnPrintSelect" data-act="print-mode">⎙ Print</button>`);

  root.innerHTML = `
    <div class="list-container">
      <div class="list-header">
        <div class="list-title">Active Projects</div>
        <div class="list-actions">
          <button class="btn-header" data-act="print-list">⎙ Print List</button>
          <button class="btn-new-project" data-act="new-job">+ New Project</button>
        </div>
      </div>
      <div class="filter-bar">
        ${STATUSES.map((s) => `<button class="filter-btn${filters.has(s) ? " active" : ""}" data-act="filter" data-status="${s}">${statusLabel(s)}</button>`).join("")}
        <button class="lead-toggle${groupByLead ? " on" : ""}" data-act="lead-toggle">Group by Lead</button>
      </div>
      <div class="print-bar hidden" id="printBar">
        <div class="print-bar-left">Select projects to print — <span id="printCount">0</span> selected</div>
        <div>
          <button class="btn-print-cancel" data-act="print-mode">Cancel</button>
          <button class="btn-print-go" data-act="print-go">Print Selected</button>
        </div>
      </div>
      <div class="os-strip" id="osStrip"></div>
      <div class="project-table" id="projectTable">
        <div class="table-head" id="tableHead"></div>
        <div id="projectList"><div class="loading-state">Loading projects…</div></div>
      </div>
    </div>`;

  renderTableHead();
  try {
    [jobs, dash] = await Promise.all([loadJobs(), loadDashboard().catch((e) => { console.warn("dashboard strip", e); return null; })]);
    renderList();
    renderDashboard();
  } catch (e) {
    $("projectList").innerHTML = `<div class="empty-state"><div class="icon">⚠</div><p>Error: ${esc(e.message)}</p></div>`;
  }
}

const COLUMNS = [
  ["estimateNumber", "Est #"], ["priority", "Pri"], ["clientLastName", "Project"],
  ["startDate", "Walk/Plan", "center"], ["fabStart", "Fab St", "center"], ["restoStart", "Resto St", "center"],
  [null, "Remaining"], [null, "Hours"], ["leadTech", "Lead"], ["status", "Status"],
];

function renderTableHead() {
  const head = $("tableHead"); if (!head) return;
  head.innerHTML = (printMode ? "<div></div>" : "") + COLUMNS.map(([col, label, align]) => {
    if (!col) return `<div>${label}</div>`;
    const arrow = sortCol === col ? sortDir : "";
    return `<div class="sortable${align ? " " + align : ""}" data-act="sort" data-col="${col}">${label} <span class="sort-arrow ${arrow}"></span></div>`;
  }).join("");
}

/** The OS dashboard strip: lead times, unbilled, open A/R. */
function renderDashboard() {
  const el = $("osStrip"); if (!el) return;
  const d = dash || {};
  // The visible-contract tally sits in the same strip as the OS numbers so
  // the whole block reads as one and stays put while the list scrolls.
  const tallyCell = `<div class="os-cell tally"><div class="os-k">Visible contract value</div><div class="os-v" id="tallyAmount">${money(tally.total)}</div><div class="os-s" id="tallyCount">${tally.count} project${tally.count !== 1 ? "s" : ""}</div></div>`;
  if (!dash) { el.innerHTML = tallyCell; el.style.display = "flex"; return; }
  const cells = (d.leadTimes || []).map((l) => `
    <div class="os-cell lead" data-act="lead-cell" data-key="${esc(l.key)}" title="See what leads up to this opening">
      <div class="os-k">Lead · ${esc(l.label)}</div>
      <div class="os-v">${esc(l.say)}</div>
      <div class="os-s">week of ${esc(l.week)} · ~${esc(l.weeksOut)} wk</div>
    </div>`);
  cells.unshift(tallyCell);
  cells.push(`<div class="os-cell money"><div class="os-k">Unbilled on live jobs</div><div class="os-v">${money(d.unbilled)}</div><div class="os-s">${d.unbilledJobs || 0} of ${d.liveJobs || 0} jobs · contract minus invoiced</div></div>`);
  cells.push(`<div class="os-cell ar"><div class="os-k">Invoiced, not yet paid</div><div class="os-v">${money(d.openAR)}</div><div class="os-s">open A/R per QuickBooks</div></div>`);
  cells.push(`<div class="os-foot">Lead times from the schedule board as of ${esc(d.leadTimesAsOf || "?")} · strip refreshed ${fmtStamp(d.updatedAt)} by the OS</div>`);
  el.innerHTML = cells.join("");
  el.style.display = "flex";
}

/** Jobs that pass the status filter, in the chosen order. */
function visibleJobs() {
  const list = filters.size ? jobs.filter((p) => filters.has(statusOf(p))) : jobs.slice();
  const num = (v) => parseInt(v, 10) || 0;
  if (!sortCol) {
    // Default: priority first, then newest estimate.
    return list.sort((a, b) => (a.priority || 999) - (b.priority || 999) || num(b.estimateNumber) - num(a.estimateNumber));
  }
  const dir = sortDir === "asc" ? 1 : -1;
  return list.sort((a, b) => {
    if (sortCol === "estimateNumber") return dir * (num(a.estimateNumber) - num(b.estimateNumber));
    if (sortCol === "priority") return dir * ((a.priority ?? 99999) - (b.priority ?? 99999));
    let av, bv;
    if (["startDate", "fabStart", "restoStart"].includes(sortCol)) {
      av = a[sortCol] || "zzzz"; bv = b[sortCol] || "zzzz"; // blanks last either way
    } else {
      av = String(a[sortCol] || "").toLowerCase(); bv = String(b[sortCol] || "").toLowerCase();
    }
    return av < bv ? -dir : av > bv ? dir : 0;
  });
}

function renderList() {
  const list = visibleJobs();
  const total = list.reduce((s, p) => s + Math.max(0, remainingOf(p)), 0);
  tally = { total, count: list.length };
  if ($("tallyAmount")) $("tallyAmount").textContent = money(total);
  if ($("tallyCount")) $("tallyCount").textContent = `${list.length} project${list.length !== 1 ? "s" : ""}`;
  $("projectTable").classList.toggle("print-mode", printMode);
  renderTableHead();

  const out = $("projectList");
  if (!list.length) { out.innerHTML = `<div class="empty-state"><div class="icon">📋</div><p>No projects found.</p></div>`; return; }
  if (!groupByLead) { out.innerHTML = list.map(rowHtml).join(""); return; }

  // Group by lead tech, unassigned last.
  const groups = new Map();
  list.forEach((p) => { const k = (p.leadTech || "").trim() || "__none__"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); });
  const keys = [...groups.keys()].sort((a, b) => a === "__none__" ? 1 : b === "__none__" ? -1 : a.localeCompare(b));
  out.innerHTML = keys.map((k) => {
    const g = groups.get(k);
    const gTotal = g.reduce((s, p) => s + (p.totalAmount || 0), 0);
    return `<div class="lead-divider">
        <div><span class="lead-divider-name">${k === "__none__" ? "No Lead Assigned" : esc(k)}</span><span class="lead-divider-tally">${g.length} project${g.length !== 1 ? "s" : ""}</span></div>
        <div class="lead-divider-total">${money(gTotal)}</div>
      </div>` + g.map(rowHtml).join("");
  }).join("");
}

function rowHtml(p) {
  const s = statusOf(p);
  const remaining = remainingOf(p);
  const tip = p.invoicedTotal != null ? ` title="Invoiced ${money(p.invoicedTotal)} per QuickBooks"` : "";
  const act = printMode ? `data-act="print-select"` : `data-act="open"`;
  return `<div class="project-row${printMode ? " print-mode" : ""}" ${act} data-id="${esc(p.id)}">
      ${printMode ? `<div class="print-check${printSelected.has(p.id) ? " selected" : ""}"></div>` : ""}
      <div class="est-num">#${esc(p.estimateNumber || p.id)}</div>
      <div class="est-num">${esc(p.priority || "—")}</div>
      <div class="client-cell"><div class="last-name">${esc(p.clientLastName || "—")}</div><div class="full-name">${esc(p.clientFullName || "")}</div></div>
      <div class="date-cell">${fmtDate(p.startDate)}</div>
      <div class="date-cell">${fmtDate(p.fabStart)}</div>
      <div class="date-cell">${fmtDate(p.restoStart)}</div>
      <div class="amount-cell${remaining < (p.totalAmount || 0) ? " partial" : ""}"${tip}>${money(remaining)}</div>
      <div class="hours-cell">${esc(p.hoursTotal || "—")} hrs</div>
      <div class="lead-cell">${esc(p.leadTech || "—")}</div>
      <div><span class="status-badge status-${s}">${statusLabel(s)}</span></div>
    </div>`;
}

function setSort(col) {
  if (sortCol === col) sortDir = sortDir === "asc" ? "desc" : "asc";
  else { sortCol = col; sortDir = "asc"; }
  renderList();
}

// ── Print packet ─────────────────────────────────────────────────────

function togglePrintMode() {
  printMode = !printMode;
  printSelected.clear();
  const btn = $("btnPrintSelect"), bar = $("printBar");
  if (btn) { btn.classList.toggle("active", printMode); btn.textContent = printMode ? "⎙ Printing…" : "⎙ Print"; }
  if (bar) bar.classList.toggle("hidden", !printMode);
  if ($("projectList")) renderList();
}

function togglePrintSelect(id, row) {
  if (printSelected.has(id)) printSelected.delete(id); else printSelected.add(id);
  row.querySelector(".print-check").classList.toggle("selected", printSelected.has(id));
  $("printCount").textContent = printSelected.size;
}

/** Fetch the selected jobs fresh, open them in a new window, and print. */
async function executePrint() {
  if (!printSelected.size) { toast("No projects selected", true); return; }
  try {
    const fetched = await Promise.all([...printSelected].map(getJob));
    const html = buildPrintDoc(fetched.filter(Boolean), await printCss());
    const win = window.open("", "_blank");
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 600);
    togglePrintMode();
  } catch (e) { toast("Print error: " + e.message, true); }
}

/** The stylesheet as inline text, so the print window has it before printing. */
async function printCss() {
  const url = new URL("./style.css", import.meta.url).href;
  try { const r = await fetch(url); if (r.ok) return `<style>${await r.text()}</style>`; } catch (_) { /* fall through */ }
  return `<link rel="stylesheet" href="${url}">`;
}

function buildPrintDoc(projects, css) {
  const fonts = `<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">${fonts}${css}</head><body>${projects.map(printPageHtml).join("")}</body></html>`;
}

function printPageHtml(p) {
  const cl = p.checklist || {};
  const custom = cl.custom || {};
  const removed = p.removedTasks || {};
  const section = (key) => {
    const labels = CHECKLIST_LABELS[key], data = cl[key] || {};
    const std = Object.keys(labels).filter((k) => !(removed[key] || []).includes(k));
    const cust = custom[key] || [];
    const done = std.filter((k) => data[k]).length + cust.filter((i) => i.done).length;
    const items = std.map((k) => checkItemHtml(labels[k], !!data[k], "")).join("")
      + cust.map((i) => checkItemHtml(i.label, !!i.done, " custom-item")).join("");
    return `<div class="detail-section"><div class="section-head"><div class="section-label">${SECTION_TITLES[key]}</div><div class="section-progress">${done}/${std.length + cust.length}</div></div><div class="checklist-body">${items}</div></div>`;
  };
  const hours = (p.hoursBudget || []).map((h) => `<tr><td>${esc(h.scope)}</td><td class="hours-num">${esc(h.units)}</td><td class="hours-num">${esc(h.benchmark)}</td><td class="hours-num">${esc(h.total)} hrs</td></tr>`).join("");
  const supplies = (p.supplies || []).filter((s) => s.item).map((s) => `<tr><td>${esc(s.item)}</td><td>${esc(s.qty)}</td><td>${esc(s.unit)}</td><td>${esc(s.notes)}</td></tr>`).join("");
  const fact = (label, v) => `<div class="info-card"><div class="info-label">${label}</div><div class="info-value">${esc(v || "—")}</div></div>`;

  return `<div class="detail-container">
    <div class="detail-header-card">
      <div style="flex:1"><div class="detail-client-name">${esc(p.clientLastName || "—")}</div>
      <div class="detail-subtitle">${esc(p.clientFullName)}<br>${esc(p.address)} · ${esc(p.phone)}</div></div>
      <div class="detail-right"><div class="detail-est">Est #${esc(p.estimateNumber || p.id)}</div><div class="detail-amount">${money(p.totalAmount)}</div></div>
    </div>
    <div class="info-grid last">
      ${fact("Status", statusLabel(statusOf(p)))}${fact("Priority", p.priority)}${fact("Lead Tech", p.leadTech)}
      ${fact("Walk / Plan", p.startDate)}${fact("Fab Start", p.fabStart)}${fact("Resto Start", p.restoStart)}
    </div>
    ${section("preProject")}${section("production")}${section("closeout")}
    <div class="detail-section zone-green"><div class="section-head"><div class="section-label">Hours Budget</div><div class="section-progress">${esc(p.hoursTotal || 0)} hrs total</div></div>
      <table class="hours-table"><thead><tr><th>Scope</th><th>Units</th><th>Benchmark</th><th>Total</th></tr></thead><tbody>${hours}
      <tr class="total-row"><td>Project Total</td><td></td><td></td><td class="hours-num">${esc(p.hoursTotal || 0)} hrs</td></tr></tbody></table></div>
    <div class="detail-section zone-amber"><div class="section-head"><div class="section-label">Materials Scope Summary</div></div><div class="materials-body">${esc(p.materialsSummary || "—")}</div></div>
    ${supplies ? `<div class="detail-section zone-blue"><div class="section-head"><div class="section-label">Project-Specific Supplies</div></div><table class="supplies-table"><thead><tr><th>Item</th><th>Qty</th><th>Unit</th><th>Notes</th></tr></thead><tbody>${supplies}</tbody></table></div>` : ""}
    ${p.notes ? `<div class="detail-section"><div class="section-head"><div class="section-label">Notes</div></div><div class="materials-body">${esc(p.notes)}</div></div>` : ""}
  </div>`;
}

function checkItemHtml(label, done, extraClass) {
  return `<div class="check-item${extraClass}${done ? " done" : ""}"><div class="check-box${done ? " checked" : ""}"></div><span class="check-label">${esc(label)}</span></div>`;
}

// ═════════════════════════════════════════════════════════════════════
// DETAIL VIEW
// ═════════════════════════════════════════════════════════════════════

async function openJob(id) {
  try {
    const p = await getJob(id);
    if (!p) { toast("Project not found", true); return; }
    job = p;
    renderDetail();
    window.scrollTo(0, 0);
  } catch (e) { toast("Error loading project: " + e.message, true); }
}

/** Build the whole detail page from `job`. Called again after structural edits. */
function renderDetail() {
  const p = job;
  setHeaderNav(`<button class="btn-header" data-act="back">← All Projects</button><button class="btn-header primary" id="btnSaveTop" data-act="save" ${dirty ? "" : "hidden"}>Save</button>`);

  // Working copies of the row tables. Each row gets a local id for editing.
  hoursRows = (p.hoursBudget || []).map((h) => {
    const rate = parseFloat(String(h.benchmark || "").replace(/[^0-9.]/g, "")) || (h.total / (h.units || 1)) || 0;
    return { id: uid(), scope: h.scope || "", units: h.units || 0, rate, total: h.total || 0, type: h.type || detectType(h.scope) };
  });
  suppliesRows = (p.supplies || []).map((s) => ({ id: uid(), ...s }));
  paymentRows = (p.payments || []).map((r) => ({ id: uid(), ...r }));
  schedRows = (p.schedulingCards || []).map((c) => ({ id: uid(), ...c }));

  const current = statusOf(p);
  const statusOpts = STATUSES.map((s) => `<option value="${s}"${current === s ? " selected" : ""}>${statusLabel(s)}</option>`).join("");
  const editable = (field, value, cls) => `<span contenteditable="true" class="${cls}" data-field="${field}">${esc(value)}</span>`;

  root.innerHTML = `<div class="detail-container">
    <div class="detail-header-card">
      <div style="flex:1;min-width:0;">
        <div class="detail-client-name">${editable("clientLastName", p.clientLastName || "—", "editable-heading")}</div>
        <div class="detail-subtitle">
          ${editable("clientFullName", p.clientFullName, "editable-inline")}<br>
          ${editable("address", p.address, "editable-inline")} <span class="dot">·</span> ${editable("phone", p.phone, "editable-inline")}
        </div>
      </div>
      <div class="detail-right">
        <div class="detail-est">Est #${editable("estimateNumber", p.estimateNumber || "—", "editable-inline")}</div>
        <div class="detail-amount">$${editable("totalAmount", (p.totalAmount || 0).toLocaleString(), "editable-inline")}</div>
      </div>
    </div>
    <div class="info-grid${hasOsFacts(p) ? "" : " last"}">
      <div class="info-card"><div class="info-label">Status</div><select class="status-select" data-field="status">${statusOpts}</select></div>
      <div class="info-card"><div class="info-label">Priority</div><input class="info-input" type="number" min="1" placeholder="—" value="${esc(p.priority ?? "")}" data-field="priority"></div>
      <div class="info-card"><div class="info-label">Lead Tech</div><input class="info-input" type="text" maxlength="4" placeholder="—" value="${esc(p.leadTech)}" data-field="leadTech"></div>
      <div class="info-card"><div class="info-label">Walk / Plan</div><input class="info-input" type="date" value="${esc(p.startDate)}" data-field="startDate"></div>
      <div class="info-card"><div class="info-label">Fab Start</div><input class="info-input" type="date" value="${esc(p.fabStart)}" data-field="fabStart"></div>
      <div class="info-card"><div class="info-label">Resto Start</div><input class="info-input" type="date" value="${esc(p.restoStart)}" data-field="restoStart"></div>
    </div>
    ${osFactsHtml(p)}

    <div class="detail-section zone-green">
      <div class="section-head"><div class="section-label">Hours Budget</div><div class="section-progress" id="detailHoursTotal">${hoursTotal()} hrs total</div></div>
      <div id="hoursWrap"></div>
      <button class="btn-add-row" data-act="hours-add">+ Add Row</button>
    </div>

    <div class="detail-section zone-purple">
      <div class="section-head"><div class="section-label">Scheduling</div>
        <div class="sched-actions">
          <button class="btn-sched" data-act="sched-push">Push to Scheduler ↗</button>
          <button class="btn-sched ghost" data-act="sched-sync">Sync Dates ↙</button>
        </div>
      </div>
      <div class="sched-body" id="schedWrap"></div>
    </div>

    <div class="detail-section zone-amber">
      <div class="section-head"><div class="section-label">Materials Scope Summary</div></div>
      <textarea class="editable-area" placeholder="Materials notes…" data-field="materialsSummary">${esc(p.materialsSummary)}</textarea>
    </div>

    <div class="detail-section zone-blue">
      <div class="section-head"><div class="section-label">Project-Specific Supplies</div></div>
      <div id="suppliesWrap"></div>
      <button class="btn-add-row" data-act="sup-add">+ Add Item</button>
    </div>

    <div class="detail-section zone-green">
      <div class="section-head"><div class="section-label">Payments Received</div><div class="section-progress" id="paymentsRemaining"></div></div>
      <div id="paymentsWrap"></div>
      <button class="btn-add-row" data-act="pay-add">+ Add Payment</button>
    </div>

    <div class="detail-section">
      <div class="section-head"><div class="section-label">Notes</div></div>
      <textarea class="editable-area" placeholder="Add project notes…" data-field="notes">${esc(p.notes)}</textarea>
    </div>

    ${["preProject", "production", "closeout"].map(checklistSectionHtml).join("")}

    <div class="detail-foot">
      <button class="btn-delete-project" data-act="delete-job">Delete Project</button>
      <button class="btn-save" data-act="save">Save Changes</button>
    </div>
  </div>`;

  renderHoursTable();
  renderSchedTable();
  renderSuppliesTable();
  renderPaymentsTable();
}

// ── Read-only facts the OS writes onto a job ─────────────────────────

const OS_FIELDS = ["currentEstimate", "osFolder", "osRefreshed", "harvestProjects", "harvestBudget", "invoicedTotal", "openBalance"];
function hasOsFacts(p) { return OS_FIELDS.some((k) => p[k] != null && p[k] !== ""); }

function osFactsHtml(p) {
  if (!hasOsFacts(p)) return "";
  const fact = (label, v, mono) => v == null || v === "" ? "" : `<div class="os-fact"><div class="k">${label}</div><div class="v${mono ? " mono" : ""}">${v}</div></div>`;
  // harvestProjects may be { name: id } or [{ name, id }]
  let harvest = "";
  if (p.harvestProjects) {
    const pairs = Array.isArray(p.harvestProjects) ? p.harvestProjects.map((h) => [h.name, h.id]) : Object.entries(p.harvestProjects);
    harvest = pairs.map(([n, id]) => `${esc(n)} <span class="mono">(${esc(id)})</span>`).join("<br>");
  }
  return `<div class="os-facts">
    ${fact("Current est #", esc(p.currentEstimate), true)}
    ${fact("Harvest projects", harvest)}
    ${fact("Harvest budget", p.harvestBudget != null ? esc(p.harvestBudget) + " hrs" : null, true)}
    ${fact("Invoiced", p.invoicedTotal != null ? money(p.invoicedTotal) : null, true)}
    ${fact("Open balance", p.openBalance != null ? money(p.openBalance) : null, true)}
    ${fact("OS folder", esc(p.osFolder), true)}
    ${p.osRefreshed ? `<div class="os-foot">Refreshed by the OS ${esc(p.osRefreshed)}</div>` : ""}
  </div>`;
}

// ── Hours budget ─────────────────────────────────────────────────────

function detectType(scope) {
  const s = (scope || "").toLowerCase();
  if (s.startsWith("fab")) return "fab";
  if (s.startsWith("walk") || s.startsWith("plan")) return "walk";
  return "resto";
}
function hoursTotal() { return Math.round(hoursRows.reduce((s, r) => s + (r.total || 0), 0) * 10) / 10; }

function renderHoursTable() {
  const rows = hoursRows.map((r) => {
    const opts = ["fab", "resto", "walk"].map((t) => `<option value="${t}"${r.type === t ? " selected" : ""}>${t.charAt(0).toUpperCase() + t.slice(1)}</option>`).join("");
    return `<tr>
      <td><select class="type-select type-${r.type}" data-table="hours" data-id="${r.id}" data-col="type">${opts}</select></td>
      <td><input class="cell-edit" type="text" value="${esc(r.scope)}" data-table="hours" data-id="${r.id}" data-col="scope"></td>
      <td><input class="cell-edit num" type="number" min="0" value="${esc(r.units)}" data-table="hours" data-id="${r.id}" data-col="units"></td>
      <td><input class="cell-edit num" type="number" min="0" step="0.5" value="${esc(r.rate)}" data-table="hours" data-id="${r.id}" data-col="rate"></td>
      <td><span class="total-display" id="hrow-${r.id}">${r.total || 0} hrs</span></td>
      <td><button class="btn-del-row" data-act="hours-del" data-id="${r.id}">×</button></td>
    </tr>`;
  }).join("");
  $("hoursWrap").innerHTML = `<table class="hours-table"><thead><tr><th>Type</th><th>Scope</th><th style="width:55px">Units</th><th style="width:90px">Rate (hrs/unit)</th><th style="width:65px">Total</th><th style="width:30px"></th></tr></thead>
    <tbody>${rows}<tr class="total-row"><td></td><td>Project Total</td><td></td><td></td><td id="hoursTotalCell">${hoursTotal()} hrs</td><td></td></tr></tbody></table>`;
}

function updateHoursRow(id, col, value) {
  const r = hoursRows.find((x) => x.id === id); if (!r) return;
  if (col === "type") { r.type = value; renderHoursTable(); }
  else r[col] = col === "scope" ? value : (parseFloat(value) || 0);
  r.total = Math.round(r.units * r.rate * 10) / 10;
  const cell = $("hrow-" + id); if (cell) cell.textContent = r.total + " hrs";
  $("hoursTotalCell").textContent = hoursTotal() + " hrs";
  $("detailHoursTotal").textContent = hoursTotal() + " hrs total";
  syncHours(); markDirty();
}

function syncHours() {
  job.hoursBudget = hoursRows.map((r) => ({ scope: r.scope, units: r.units, benchmark: r.rate + " hrs/unit", total: r.total, type: r.type || detectType(r.scope) }));
  job.hoursTotal = hoursTotal();
}

// ── Scheduling rows (crew cards) ─────────────────────────────────────

function renderSchedTable() {
  const rows = schedRows.map((r) => {
    const opts = Object.entries(SCHED_TYPES).map(([t, l]) => `<option value="${t}"${r.type === t ? " selected" : ""}>${l}</option>`).join("");
    const d = `data-table="sched" data-id="${r.id}"`;
    return `<tr>
      <td><select class="sched-type-${esc(r.type)}" ${d} data-col="type">${opts}</select></td>
      <td><input type="text" value="${esc(r.emp)}" style="width:76px" ${d} data-col="emp"></td>
      <td><input type="date" class="mono" value="${esc(r.start)}" ${d} data-col="start"></td>
      <td class="num"><input type="number" class="mono num" min="1" value="${esc(r.days || 1)}" ${d} data-col="days"></td>
      <td class="num"><input type="number" class="mono num" min="0" step="0.5" value="${esc(r.hrs || 0)}" ${d} data-col="hrs"></td>
      <td><button class="btn-x" data-act="sched-del" data-id="${r.id}">×</button></td>
    </tr>`;
  }).join("");
  const sum = (t) => schedRows.filter((r) => r.type === t).reduce((s, r) => s + (parseFloat(r.hrs) || 0), 0);
  const resto = sum("resto"), fab = sum("fab"), walk = sum("walk");
  $("schedWrap").innerHTML = `
    <table class="sched-table"><thead><tr><th>Type</th><th>Assigned To</th><th>Start</th><th class="num">Days</th><th class="num">Hours</th><th></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="6" class="sched-empty">No crew rows yet.</td></tr>`}</tbody></table>
    <button class="btn-sched-add" data-act="sched-add">+ Add Row</button>
    <div class="harvest-summary"><div class="title">Harvest Entry Summary</div><table>
      <tr><td>Restoration</td><td class="num">${resto} hrs</td></tr>
      <tr><td>Fabrication</td><td class="num">${fab} hrs</td></tr>
      <tr><td>Walk / Plan</td><td class="num">${walk} hrs</td></tr>
      <tr class="total"><td>Total</td><td class="num">${resto + fab + walk} hrs</td></tr>
    </table></div>`;
}

function updateSchedRow(id, col, value) {
  const r = schedRows.find((x) => x.id === id); if (!r) return;
  r[col] = col === "days" ? (parseInt(value, 10) || 1) : col === "hrs" ? (parseFloat(value) || 0) : value;
  syncSched();
  if (col === "type" || col === "hrs") renderSchedTable(); // colour and totals
  markDirty();
}
function syncSched() {
  job.schedulingCards = schedRows.map((r) => ({ type: r.type, emp: r.emp || "", start: r.start || "", days: parseInt(r.days, 10) || 1, hrs: parseFloat(r.hrs) || 0 }));
}

function addBizDays(startStr, n) {
  const [y, m, d] = startStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  for (let added = 0; added < n;) { date.setDate(date.getDate() + 1); if (date.getDay() % 6) added++; }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Append this job's rows as cards on boards/schedule. Reworked in step 3. */
async function pushToScheduler() {
  const p = job;
  if (!p.priority) { toast("Set a Priority # first — it links to the scheduler", true); return; }
  const desc = { walk: "Walk/Plan", fab: "Shop Fabrication", paint: "Paint/Install", resto: "Restoration", off: "Time Off" };
  const cards = schedRows.filter((r) => r.start && r.emp).map((r) => {
    const days = Math.max(parseInt(r.days, 10) || 1, 1);
    return { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), emp: r.emp, type: r.type, client: p.clientLastName || "", desc: desc[r.type] || r.type, startDate: r.start, endDate: addBizDays(r.start, days - 1), priorityId: p.priority };
  });
  if (!cards.length) { toast("No cards to push — fill in rows in the Scheduling section first", true); return; }
  if (!confirm(`Push ${cards.length} card(s) to Scheduler for #${p.priority} ${p.clientLastName || ""}?\n\nExisting cards for this project will not be removed.`)) return;
  try {
    const existing = await loadScheduleCards();
    await saveScheduleCards(existing.concat(cards));
    toast(`Pushed ${cards.length} card(s) to Scheduler ✓`);
  } catch (e) { toast("Push failed: " + e.message, true); }
}

/** Pull the earliest fab/resto/walk card dates for this priority back onto the job. */
async function syncFromScheduler() {
  const p = job;
  if (!p.priority) { toast("No Priority # set — cannot match scheduler cards", true); return; }
  try {
    const linked = (await loadScheduleCards()).filter((c) => c.priorityId === p.priority && c.type !== "off");
    if (!linked.length) { toast("No cards found for Priority #" + p.priority, true); return; }
    const first = (t) => linked.filter((c) => c.type === t).map((c) => c.startDate).sort()[0] || null;
    const fab = first("fab"), resto = first("resto"), walk = first("walk");
    let msg = "Sync dates from Scheduler?\n";
    if (fab) msg += "\nFab Start: " + fab;
    if (resto) msg += "\nResto Start: " + resto;
    if (walk) msg += "\nWalk/Plan: " + walk;
    if (!confirm(msg)) return;
    if (fab) p.fabStart = fab;
    if (resto) p.restoStart = resto;
    if (walk) p.startDate = walk;
    markDirty(); renderDetail();
    toast("Dates synced from Scheduler ✓");
  } catch (e) { toast("Sync failed: " + e.message, true); }
}

// ── Supplies ─────────────────────────────────────────────────────────

function renderSuppliesTable() {
  const rows = suppliesRows.map((r) => {
    const d = `data-table="supplies" data-id="${r.id}"`;
    return `<tr>
      <td><input class="sup-input" type="text" value="${esc(r.item)}" placeholder="Item description" ${d} data-col="item"></td>
      <td><input class="sup-input num" type="number" min="0" value="${esc(r.qty)}" ${d} data-col="qty"></td>
      <td><input class="sup-input" type="text" value="${esc(r.unit)}" placeholder="ea / ft / pkg" ${d} data-col="unit"></td>
      <td><input class="sup-input" type="text" value="${esc(r.notes)}" placeholder="Notes" ${d} data-col="notes"></td>
      <td><button class="btn-del-row" data-act="sup-del" data-id="${r.id}">×</button></td>
    </tr>`;
  }).join("");
  $("suppliesWrap").innerHTML = `<table class="supplies-table"><thead><tr><th>Item</th><th style="width:60px">Qty</th><th style="width:80px">Unit</th><th>Notes</th><th style="width:30px"></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="5" class="empty">No supplies added yet.</td></tr>`}</tbody></table>`;
}
function syncSupplies() {
  job.supplies = suppliesRows.map((r) => ({ item: r.item || "", qty: r.qty || "", unit: r.unit || "", notes: r.notes || "" }));
}

// ── Payments ─────────────────────────────────────────────────────────

function renderPaymentsTable() {
  const rows = paymentRows.map((r) => {
    const d = `data-table="payments" data-id="${r.id}"`;
    return `<tr>
      <td><input class="sup-input" type="text" value="${esc(r.invoiceNum)}" placeholder="INV-001" ${d} data-col="invoiceNum"></td>
      <td><input class="sup-input" type="date" value="${esc(r.payDate)}" ${d} data-col="payDate"></td>
      <td><input class="sup-input num" type="number" min="0" value="${esc(r.amount)}" placeholder="0" ${d} data-col="amount"></td>
      <td><button class="btn-del-row" data-act="pay-del" data-id="${r.id}">×</button></td>
    </tr>`;
  }).join("");
  $("paymentsWrap").innerHTML = `<table class="supplies-table"><thead><tr><th>Invoice #</th><th style="width:120px">Pay Date</th><th style="width:110px">Amount ($)</th><th style="width:30px"></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="4" class="empty">No payments recorded yet.</td></tr>`}</tbody></table>`;
  updatePaymentsSummary();
}

function updatePaymentsSummary() {
  const el = $("paymentsRemaining"); if (!el) return;
  const paid = paymentRows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
  const remaining = (job.totalAmount || 0) - paid;
  el.textContent = paid > 0 ? `${money(paid)} paid · ${money(remaining)} remaining` : `${money(job.totalAmount)} outstanding`;
  el.classList.toggle("paid", paid > 0 && remaining <= 0);
}
function syncPayments() {
  job.payments = paymentRows.map((r) => ({ invoiceNum: r.invoiceNum || "", payDate: r.payDate || "", amount: parseFloat(r.amount) || 0 }));
}

// ── Checklists ───────────────────────────────────────────────────────

function checklistSectionHtml(section) {
  const labels = CHECKLIST_LABELS[section];
  const data = (job.checklist || {})[section] || {};
  const removed = (job.removedTasks || {})[section] || [];
  const custom = ((job.checklist || {}).custom || {})[section] || [];
  const std = Object.keys(labels).filter((k) => !removed.includes(k));
  const done = std.filter((k) => data[k]).length + custom.filter((i) => i.done).length;

  const actions = (edit, del) => `<span class="item-actions"><button class="btn-item-action btn-item-edit" data-act="${edit}" title="Edit">✎</button><button class="btn-item-action" data-act="${del}" title="Delete">×</button></span>`;
  const items = std.map((k) => `<div class="check-item${data[k] ? " done" : ""}" data-act="check" data-section="${section}" data-key="${k}"><div class="check-box${data[k] ? " checked" : ""}"></div><span class="check-label">${esc(labels[k])}</span>${actions("edit-std", "del-std")}</div>`).join("")
    + custom.map((i, idx) => `<div class="check-item custom-item${i.done ? " done" : ""}" data-act="check-custom" data-section="${section}" data-idx="${idx}"><div class="check-box${i.done ? " checked" : ""}"></div><span class="check-label">${esc(i.label)}</span>${actions("edit-custom", "del-custom")}</div>`).join("")
    + `<div class="add-task-row"><input class="add-task-input" id="add-${section}" type="text" placeholder="+ Add task…" data-section="${section}"><button class="btn-add-task" data-act="add-custom" data-section="${section}">Add</button></div>`;

  return `<div class="detail-section"><div class="section-head"><div class="section-label">${SECTION_TITLES[section]}</div><div class="section-progress" id="prog-${section}">${done}/${std.length + custom.length}</div></div><div class="checklist-body">${items}</div></div>`;
}

function updateProgress(section) {
  const cl = job.checklist || {};
  const removed = (job.removedTasks || {})[section] || [];
  const std = Object.keys(CHECKLIST_LABELS[section]).filter((k) => !removed.includes(k));
  const custom = (cl.custom || {})[section] || [];
  const done = std.filter((k) => (cl[section] || {})[k]).length + custom.filter((i) => i.done).length;
  $("prog-" + section).textContent = `${done}/${std.length + custom.length}`;
}

/** Make sure job.checklist[...] paths exist before writing into them. */
function checklistPath(section) {
  job.checklist ??= {};
  job.checklist[section] ??= {};
  job.checklist.custom ??= {};
  job.checklist.custom[section] ??= [];
  job.removedTasks ??= {};
  job.removedTasks[section] ??= [];
}

function toggleStd(section, key, el) {
  checklistPath(section);
  const val = !job.checklist[section][key];
  job.checklist[section][key] = val;
  el.classList.toggle("done", val); el.querySelector(".check-box").classList.toggle("checked", val);
  updateProgress(section); markDirty();
}
function toggleCustom(section, idx, el) {
  checklistPath(section);
  const item = job.checklist.custom[section][idx]; if (!item) return;
  item.done = !item.done;
  el.classList.toggle("done", item.done); el.querySelector(".check-box").classList.toggle("checked", item.done);
  updateProgress(section); markDirty();
}
function addCustom(section) {
  const label = ($("add-" + section).value || "").trim(); if (!label) return;
  checklistPath(section);
  job.checklist.custom[section].push({ label, done: false });
  markDirty(); renderDetail();
}
/** Editing a standard item turns it into a custom one and hides the original. */
function editStd(section, key) {
  const current = CHECKLIST_LABELS[section][key];
  const label = prompt("Edit task label:", current);
  if (!label || !label.trim() || label.trim() === current) return;
  checklistPath(section);
  job.removedTasks[section].push(key);
  job.checklist.custom[section].unshift({ label: label.trim(), done: !!job.checklist[section][key] });
  markDirty(); renderDetail();
}
function deleteStd(section, key) {
  if (!confirm(`Remove "${CHECKLIST_LABELS[section][key]}" from this project?`)) return;
  checklistPath(section);
  if (!job.removedTasks[section].includes(key)) job.removedTasks[section].push(key);
  markDirty(); renderDetail();
}
function editCustom(section, idx) {
  const item = job.checklist?.custom?.[section]?.[idx]; if (!item) return;
  const label = prompt("Edit task label:", item.label);
  if (label && label.trim()) { item.label = label.trim(); markDirty(); renderDetail(); }
}
function deleteCustom(section, idx) {
  const items = job.checklist?.custom?.[section]; if (!items) return;
  if (!confirm("Remove this task?")) return;
  items.splice(idx, 1);
  markDirty(); renderDetail();
}

// ── Header fields, save, delete ──────────────────────────────────────

/** Set one field on the job from an edited element. */
function updateField(field, el) {
  let value = el.isContentEditable ? el.textContent.trim() : el.value;
  if (field === "totalAmount") value = parseFloat(value.replace(/[^0-9.]/g, "")) || 0;
  else if (field === "priority") value = value ? parseInt(value, 10) : null;
  else if (field === "leadTech") value = value.trim();
  else if (value === "—") value = "";
  job[field] = value;
  if (field === "totalAmount") updatePaymentsSummary();
  markDirty();
}

async function saveCurrent() {
  if (!job) return;
  const btn = $("btnSave");
  btn.disabled = true; btn.textContent = "Saving…";
  $("saveStatus").textContent = "Saving…";
  syncHours(); syncSupplies(); syncPayments(); syncSched();
  try {
    await saveJob(job.id, job);
    clearDirty(); toast("Saved ✓");
  } catch (e) { toast("Save failed: " + e.message, true); }
  btn.disabled = false; btn.textContent = "Save Changes";
}

async function deleteCurrent() {
  if (!confirm(`Delete project "${job.clientLastName || job.id}"?\n\nThis cannot be undone.`)) return;
  try {
    await deleteJob(job.id);
    dirty = false;
    toast("Project deleted");
    showList();
  } catch (e) { toast("Delete failed: " + e.message, true); }
}

function backToList() {
  if (dirty && !confirm("You have unsaved changes. Leave anyway?")) return;
  dirty = false;
  showList();
}

// ═════════════════════════════════════════════════════════════════════
// NEW JOB FORM
// ═════════════════════════════════════════════════════════════════════

function showNewForm() {
  job = null; clearDirty();
  setHeaderNav(`<button class="btn-header" data-act="back">← All Projects</button>`);
  formHoursRows = [{ id: uid(), scope: "", units: "", rate: "", total: 0 }];
  const field = (id, label, input, hint = "") => `<div class="field-group"><label class="field-label">${label}</label>${input}${hint ? `<span class="field-hint">${hint}</span>` : ""}</div>`;

  root.innerHTML = `<div class="new-container">
    <div class="new-page-title">New Project</div>
    <div class="form-section"><div class="form-section-head">Project Identity</div><div class="form-body"><div class="form-grid three">
      ${field("f-est", "Estimate #", `<input class="field-input" id="f-est" type="text" placeholder="Leave blank if none yet">`, "Blank = filed as OS-Surname until the estimate exists")}
      ${field("f-status", "Status", `<select class="field-input" id="f-status">${STATUSES.map((s) => `<option value="${s}">${statusLabel(s)}</option>`).join("")}</select>`)}
      ${field("f-priority", "Priority #", `<input class="field-input" id="f-priority" type="number" min="1" placeholder="—">`)}
    </div></div></div>
    <div class="form-section"><div class="form-section-head">Client Information</div><div class="form-body"><div class="form-grid">
      ${field("f-lastname", "Project Name *", `<input class="field-input" id="f-lastname" type="text" placeholder="Surname">`)}
      ${field("f-fullname", "Full Name *", `<input class="field-input" id="f-fullname" type="text" placeholder="First Last">`)}
      <div class="field-group span2"><label class="field-label">Address</label><input class="field-input" id="f-address" type="text" placeholder="Street, Portland, OR"></div>
      ${field("f-phone", "Phone", `<input class="field-input" id="f-phone" type="text" placeholder="503-555-0100">`)}
      ${field("f-lead", "Lead Tech (initials)", `<input class="field-input" id="f-lead" type="text" maxlength="4">`)}
      ${field("f-startdate", "Start Date", `<input class="field-input" id="f-startdate" type="date">`)}
    </div></div></div>
    <div class="form-section"><div class="form-section-head">Project Details</div><div class="form-body"><div class="form-grid">
      ${field("f-amount", "Total Amount ($) *", `<input class="field-input" id="f-amount" type="number" min="0" placeholder="0">`)}
      ${field("f-scope", "Scope Summary *", `<input class="field-input" id="f-scope" type="text" placeholder="Triage ×7, Rail Prep ×7">`)}
      <div class="field-group span2"><label class="field-label">Materials Scope Summary</label><textarea class="field-input" id="f-materials" placeholder="Triage (7 openings): Sash cord…"></textarea></div>
    </div></div></div>
    <div class="form-section"><div class="form-section-head">Hours Budget</div><div class="form-body">
      <table class="hours-form-table"><thead><tr><th>Scope Type</th><th style="width:70px">Units</th><th style="width:110px">Rate (hrs/unit)</th><th style="width:80px">Total</th><th style="width:36px"></th></tr></thead><tbody id="formHoursBody"></tbody></table>
      <button class="btn-add-row" data-act="fh-add">+ Add Row</button>
      <div class="hours-project-total">Project Total: <strong id="formHoursTotal">0 hrs</strong></div>
    </div></div>
    <div class="form-section"><div class="form-section-head">Notes</div><div class="form-body"><textarea class="field-input" id="f-notes" placeholder="Initial project notes…" style="min-height:70px"></textarea></div></div>
    <div class="form-section"><div class="form-actions">
      <button class="btn-cancel" data-act="back">Cancel</button>
      <button class="btn-create" id="btnCreate" data-act="create">Create Project</button>
    </div></div>
  </div>`;
  renderFormHours();
  window.scrollTo(0, 0);
}

function renderFormHours() {
  $("formHoursBody").innerHTML = formHoursRows.map((r) => {
    const d = `data-table="formhours" data-id="${r.id}"`;
    return `<tr>
      <td><input class="cell-input" type="text" placeholder="Site - Triage" value="${esc(r.scope)}" ${d} data-col="scope"></td>
      <td><input class="cell-input num" type="number" min="0" placeholder="0" value="${esc(r.units)}" ${d} data-col="units"></td>
      <td><input class="cell-input num" type="number" min="0" step="0.5" placeholder="0.0" value="${esc(r.rate)}" ${d} data-col="rate"></td>
      <td><span class="hours-total-display" id="frow-${r.id}">${r.total > 0 ? r.total + " hrs" : "—"}</span></td>
      <td><button class="btn-del-row" data-act="fh-del" data-id="${r.id}">×</button></td>
    </tr>`;
  }).join("");
  recalcFormHours();
}

function recalcFormHours() {
  let total = 0;
  formHoursRows.forEach((r) => {
    r.total = Math.round((parseFloat(r.units) || 0) * (parseFloat(r.rate) || 0) * 10) / 10;
    total += r.total;
    const el = $("frow-" + r.id); if (el) el.textContent = r.total > 0 ? r.total + " hrs" : "—";
  });
  $("formHoursTotal").textContent = Math.round(total * 10) / 10 + " hrs";
}

/** A checklist with every standard item unticked. */
function blankChecklist() {
  const off = (labels) => Object.fromEntries(Object.keys(labels).map((k) => [k, false]));
  return {
    preProject: off(CHECKLIST_LABELS.preProject),
    production: off(CHECKLIST_LABELS.production),
    closeout: off(CHECKLIST_LABELS.closeout),
    custom: { preProject: [], production: [], closeout: [] },
  };
}

async function createFromForm() {
  const v = (id) => $(id).value.trim();
  const lastName = v("f-lastname"), fullName = v("f-fullname"), amount = v("f-amount"), scope = v("f-scope");
  if (!lastName || !fullName || !amount || !scope) { toast("Please fill in required fields", true); return; }

  // The document id is the estimate number, or OS-Surname until one exists.
  const estNum = v("f-est");
  const id = estNum || "OS-" + lastName.replace(/[^A-Za-z0-9]+/g, "");

  recalcFormHours();
  const hoursBudget = formHoursRows.filter((r) => r.scope).map((r) => ({ scope: r.scope, units: parseFloat(r.units) || 0, benchmark: r.rate + " hrs/unit", total: r.total || 0, type: detectType(r.scope) }));
  const data = {
    estimateNumber: estNum,
    clientLastName: lastName, clientFullName: fullName,
    address: v("f-address"), phone: v("f-phone"), leadTech: v("f-lead"),
    totalAmount: parseFloat(amount) || 0,
    scopeSummary: scope,
    materialsSummary: v("f-materials"),
    notes: v("f-notes"),
    supplies: [], payments: [], schedulingCards: [],
    priority: v("f-priority") ? parseInt(v("f-priority"), 10) : null,
    status: $("f-status").value || "pre-production",
    startDate: $("f-startdate").value || null,
    hoursBudget, hoursTotal: Math.round(hoursBudget.reduce((s, r) => s + r.total, 0) * 10) / 10,
    checklist: blankChecklist(),
    removedTasks: {},
  };

  const btn = $("btnCreate");
  btn.disabled = true; btn.textContent = "Creating…";
  try {
    await createJob(id, data);
    toast("Project created ✓");
    job = { id, ...data };
    renderDetail();
    window.scrollTo(0, 0);
  } catch (e) {
    toast("Error: " + e.message, true);
    btn.disabled = false; btn.textContent = "Create Project";
  }
}

// ═════════════════════════════════════════════════════════════════════
// EVENTS — one listener each for clicks, edits, and Enter in inputs
// ═════════════════════════════════════════════════════════════════════

function wireEvents() {
  // Clicks: anything with data-act. Header buttons live outside <main>, so listen on document.
  document.addEventListener("click", (e) => {
    if (!active) return;   // another tab owns the screen; its own handler deals with it
    const el = e.target.closest("[data-act]"); if (!el) return;
    const id = el.dataset.id, num = parseInt(id, 10), sec = el.dataset.section;
    // Buttons inside a check-item must not also toggle the item.
    if (el.tagName === "BUTTON") e.stopPropagation();

    switch (el.dataset.act) {
      // list
      case "sort": setSort(el.dataset.col); break;
      case "filter": filters.has(el.dataset.status) ? filters.delete(el.dataset.status) : filters.add(el.dataset.status); el.classList.toggle("active"); renderList(); break;
      case "lead-toggle": groupByLead = !groupByLead; el.classList.toggle("on", groupByLead); renderList(); break;
      case "print-mode": togglePrintMode(); break;
      case "print-go": executePrint(); break;
      case "print-list": window.print(); break;
      case "print-select": togglePrintSelect(id, el); break;
      case "open": openJob(id); break;
      case "lead-cell": document.dispatchEvent(new CustomEvent("eps:navigate", { detail: { tab: "schedule", view: "forecast", focus: el.dataset.key } })); break;
      case "new-job": showNewForm(); break;
      case "back": backToList(); break;
      // detail
      case "save": saveCurrent(); break;
      case "delete-job": deleteCurrent(); break;
      case "hours-add": hoursRows.push({ id: uid(), scope: "", units: 0, rate: 0, total: 0, type: "resto" }); renderHoursTable(); markDirty(); break;
      case "hours-del": hoursRows = hoursRows.filter((r) => r.id !== num); renderHoursTable(); $("detailHoursTotal").textContent = hoursTotal() + " hrs total"; syncHours(); markDirty(); break;
      case "sup-add": suppliesRows.push({ id: uid(), item: "", qty: "", unit: "", notes: "" }); renderSuppliesTable(); markDirty(); break;
      case "sup-del": suppliesRows = suppliesRows.filter((r) => r.id !== num); renderSuppliesTable(); syncSupplies(); markDirty(); break;
      case "pay-add": paymentRows.push({ id: uid(), invoiceNum: "", payDate: "", amount: "" }); renderPaymentsTable(); markDirty(); break;
      case "pay-del": paymentRows = paymentRows.filter((r) => r.id !== num); renderPaymentsTable(); syncPayments(); markDirty(); break;
      case "sched-add": schedRows.push({ id: uid(), type: "fab", emp: "", start: "", days: 1, hrs: 0 }); syncSched(); renderSchedTable(); markDirty(); break;
      case "sched-del": schedRows = schedRows.filter((r) => r.id !== num); syncSched(); renderSchedTable(); markDirty(); break;
      case "sched-push": pushToScheduler(); break;
      case "sched-sync": syncFromScheduler(); break;
      case "check": toggleStd(sec, el.dataset.key, el); break;
      case "check-custom": toggleCustom(sec, parseInt(el.dataset.idx, 10), el); break;
      case "add-custom": addCustom(sec); break;
      case "edit-std": { const it = el.closest(".check-item"); editStd(it.dataset.section, it.dataset.key); break; }
      case "del-std": { const it = el.closest(".check-item"); deleteStd(it.dataset.section, it.dataset.key); break; }
      case "edit-custom": { const it = el.closest(".check-item"); editCustom(it.dataset.section, parseInt(it.dataset.idx, 10)); break; }
      case "del-custom": { const it = el.closest(".check-item"); deleteCustom(it.dataset.section, parseInt(it.dataset.idx, 10)); break; }
      // new form
      case "fh-add": formHoursRows.push({ id: uid(), scope: "", units: "", rate: "", total: 0 }); renderFormHours(); break;
      case "fh-del": formHoursRows = formHoursRows.filter((r) => r.id !== num); renderFormHours(); break;
      case "create": createFromForm(); break;
    }
  });

  // Edits: table cells carry data-table/data-id/data-col; header fields carry data-field.
  const onEdit = (e) => {
    const el = e.target;
    if (el.dataset.table) {
      const id = parseInt(el.dataset.id, 10), col = el.dataset.col, v = el.value;
      if (el.dataset.table === "hours") updateHoursRow(id, col, v);
      else if (el.dataset.table === "sched") updateSchedRow(id, col, v);
      else if (el.dataset.table === "supplies") { const r = suppliesRows.find((x) => x.id === id); if (r) { r[col] = v; syncSupplies(); markDirty(); } }
      else if (el.dataset.table === "payments") { const r = paymentRows.find((x) => x.id === id); if (r) { r[col] = v; syncPayments(); updatePaymentsSummary(); markDirty(); } }
      else if (el.dataset.table === "formhours") { const r = formHoursRows.find((x) => x.id === id); if (r) { r[col] = v; recalcFormHours(); } }
    } else if (el.dataset.field && job && !el.isContentEditable) {
      updateField(el.dataset.field, el);
    }
  };
  root.addEventListener("input", (e) => { if (active) onEdit(e); });
  root.addEventListener("change", (e) => { if (active && (e.target.tagName === "SELECT" || e.target.type === "date")) onEdit(e); });
  // contenteditable header fields commit when focus leaves them
  root.addEventListener("focusout", (e) => { if (active && e.target.isContentEditable && e.target.dataset.field && job) updateField(e.target.dataset.field, e.target); });
  // Enter in the "+ Add task" box adds it; Enter in a header field ends the edit
  root.addEventListener("keydown", (e) => {
    if (!active) return;
    if (e.key !== "Enter") return;
    if (e.target.classList.contains("add-task-input")) { e.preventDefault(); addCustom(e.target.dataset.section); }
    else if (e.target.isContentEditable) { e.preventDefault(); e.target.blur(); }
  });
}
