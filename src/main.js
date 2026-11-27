import { initializeApp } from "firebase/app";
import {
  GoogleAuthProvider,
  getAuth,
  getRedirectResult,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut
} from "firebase/auth";
import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  increment,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch
} from "firebase/firestore";
import {
  OWNER_EMAIL,
  WORKSPACE_ID,
  loadFirebaseConfig,
  saveLocalFirebaseConfig
} from "./firebase-config.js";

const PENDING_INVITE_KEY = "velumix_pending_invite_v1";

const DEFAULT_COLUMNS = [
  { id: "Backlog", label: "Backlog", accent: "#8e99ad", description: "Planned roadmap, MVP gate & unbuilt asset batches" },
  { id: "Ready", label: "Ready", accent: "#0a84ff", description: "Scoped & ready to pick up or wire into Studio" },
  { id: "In Progress", label: "In Progress", accent: "#ff9f0a", description: "Actively being modeled, coded, or wired" },
  { id: "In Review / QA", label: "In Review / QA", accent: "#bf5af2", description: "Built on disk / shipped; awaiting Studio QA" },
  { id: "Done", label: "Done", accent: "#30d69c", description: "Implemented, verified, and live in-game" }
];

const DEFAULT_STAGES = [
  { id: "Missing / Unbuilt", label: "Missing / Unbuilt", accent: "#ff453a", description: "Defined in code or GDD; needs CAD/Blender modeling" },
  { id: "Designed in Kanban", label: "Designed in Kanban", accent: "#ff6b9d", description: "Full Miami architectural spec & asset_spec.json authored; ready for Velum Forge 2K render" },
  { id: "Modeled on Disk", label: "Modeled on Disk", accent: "#ff9f0a", description: "Base .blend/.fbx/.glb exists on disk; needs 2K PBR bake, variants, or QA" },
  { id: "Baked & QA Pass", label: "Baked & QA Pass", accent: "#00d4f0", description: "2K Cycles PBR + variants + LODs complete; ready to import into Studio" },
  { id: "Imported in Studio", label: "Imported in Studio", accent: "#bf5af2", description: "In Studio DataModel; needs tags, Registry spec, or textures" },
  { id: "Wired & Shipped", label: "Wired & Shipped", accent: "#30d69c", description: "Fully imported, rigged, tagged, and live in gameplay" }
];

let auth = null;
let db = null;
let currentUser = null;
let currentRole = null; // "owner" | "editor" | "viewer"
let currentView = "kanban";
let boardMeta = { columns: DEFAULT_COLUMNS, stages: DEFAULT_STAGES, metrics: {}, fieldOptions: {} };
let itemsMap = new Map();
let assetsMap = new Map();
let activeIssue = null;
let activeAsset = null;
let unsubscribers = [];

function captureUrlInvite() {
  const params = new URLSearchParams(window.location.search);
  const inv = params.get("invite");
  if (inv && inv.trim()) {
    sessionStorage.setItem(PENDING_INVITE_KEY, inv.trim());
    return inv.trim();
  }
  return sessionStorage.getItem(PENDING_INVITE_KEY) || "";
}

function clearPendingInvite() {
  sessionStorage.removeItem(PENDING_INVITE_KEY);
  const url = new URL(window.location.href);
  if (url.searchParams.has("invite")) {
    url.searchParams.delete("invite");
    window.history.replaceState({}, "", url.toString());
  }
}

function extractInviteCode(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  try {
    if (s.includes("invite=")) {
      const u = new URL(s);
      return (u.searchParams.get("invite") || "").trim();
    }
  } catch {
    const m = s.match(/[?&]invite=([^&#\s]+)/);
    if (m) return decodeURIComponent(m[1]);
  }
  return s;
}

function normalizeRenderUrl(url) {
  if (!url) return "";
  const s = String(url);
  const m = s.match(/^\/repo-assets\/models\/([^/]+)\/renders\/(.+)$/);
  if (m) {
    const webpFile = m[2].replace(/\.(png|jpg|jpeg)$/i, ".webp");
    return `./renders/${m[1]}/${webpFile}`;
  }
  if (s.startsWith("./renders/")) {
    return s.replace(/\.(png|jpg|jpeg)$/i, ".webp");
  }
  return s;
}

function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove("show"), 3000);
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function canEditBoard() {
  return currentRole === "owner" || currentRole === "editor";
}

function isOwner() {
  return currentRole === "owner";
}

function docIdForItem(item) {
  return String(item.id || `${item.repo || "velumix/SunCityRP"}#${item.number}`).replace(/\//g, "__");
}

function generateCryptoInviteCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let out = "inv_";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

async function ensureBootstrapOwner(user) {
  const wsRef = doc(db, "workspaces", WORKSPACE_ID);
  const memRef = doc(db, "workspaces", WORKSPACE_ID, "members", user.uid);
  const memSnap = await getDoc(memRef);
  if (!memSnap.exists()) {
    await setDoc(wsRef, {
      name: "Velumix Studio Kanban",
      ownerUid: user.uid,
      ownerEmail: user.email,
      updatedAt: serverTimestamp()
    }, { merge: true });
    await setDoc(memRef, {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName || "Owner",
      photoURL: user.photoURL || "",
      role: "owner",
      joinedAt: serverTimestamp()
    });
  }
  return "owner";
}

async function redeemInviteCode(user, rawCode) {
  const code = extractInviteCode(rawCode);
  if (!code || code.length < 16) {
    throw new Error("Invalid invite link or code.");
  }
  const invRef = doc(db, "workspaces", WORKSPACE_ID, "invites", code);
  const invSnap = await getDoc(invRef);
  if (!invSnap.exists()) {
    throw new Error("This invite link was not found or has expired.");
  }
  const inv = invSnap.data();
  if (!inv.active) {
    throw new Error("This invite link has been revoked by the owner.");
  }
  if (inv.expiresAt && typeof inv.expiresAt.toMillis === "function" && inv.expiresAt.toMillis() < Date.now()) {
    throw new Error("This invite link has expired.");
  }
  if (inv.maxUses && Number(inv.usedCount || 0) >= Number(inv.maxUses)) {
    throw new Error("This invite link has reached its maximum uses.");
  }

  const memRef = doc(db, "workspaces", WORKSPACE_ID, "members", user.uid);
  const batch = writeBatch(db);
  batch.set(memRef, {
    uid: user.uid,
    email: user.email || "",
    displayName: user.displayName || (user.email ? user.email.split("@")[0] : "Teammate"),
    photoURL: user.photoURL || "",
    role: inv.role === "editor" ? "editor" : "viewer",
    joinedAt: serverTimestamp(),
    inviteId: code
  });
  batch.update(invRef, {
    usedCount: increment(1),
    lastUsedAt: serverTimestamp()
  });
  await batch.commit();
  clearPendingInvite();
  return inv.role === "editor" ? "editor" : "viewer";
}

function stopRealtimeListeners() {
  for (const unsub of unsubscribers) {
    try { unsub(); } catch { /* ignore */ }
  }
  unsubscribers = [];
}

function startRealtimeListeners() {
  stopRealtimeListeners();

  // Real-time listeners are used intentionally so invited team members see live Kanban card moves & design updates instantaneously.
  unsubscribers.push(
    onSnapshot(doc(db, "workspaces", WORKSPACE_ID, "meta", "board"), (snap) => {
      if (snap.exists()) {
        const d = snap.data();
        boardMeta = {
          ...boardMeta,
          ...d,
          columns: d.columns?.length ? d.columns : DEFAULT_COLUMNS,
          stages: d.stages?.length ? d.stages : DEFAULT_STAGES
        };
        if (boardMeta.projectUrl) {
          document.getElementById("projectLink").href = boardMeta.projectUrl;
        }
      }
      populateFilters();
      renderAll();
    })
  );

  unsubscribers.push(
    onSnapshot(collection(db, "workspaces", WORKSPACE_ID, "items"), (snap) => {
      itemsMap.clear();
      snap.forEach((d) => {
        const val = d.data();
        itemsMap.set(d.id, { ...val, _docId: d.id });
      });
      document.getElementById("syncStamp").textContent = `Live Cloud (${itemsMap.size} cards · ${assetsMap.size} assets)`;
      populateFilters();
      renderAll();
    })
  );

  unsubscribers.push(
    onSnapshot(collection(db, "workspaces", WORKSPACE_ID, "assets"), (snap) => {
      assetsMap.clear();
      snap.forEach((d) => {
        const val = d.data();
        assetsMap.set(d.id, { ...val, _docId: d.id });
      });
      document.getElementById("syncStamp").textContent = `Live Cloud (${itemsMap.size} cards · ${assetsMap.size} assets)`;
      populateFilters();
      renderAll();
    })
  );
}

async function patchItemInCloud(item, patch) {
  if (!canEditBoard()) {
    showToast("Viewer role is read-only.");
    return;
  }
  const docId = item._docId || docIdForItem(item);
  Object.assign(item, patch);
  renderAll();
  try {
    await setDoc(doc(db, "workspaces", WORKSPACE_ID, "items", docId), {
      ...patch,
      updatedAt: new Date().toISOString()
    }, { merge: true });
    showToast("Saved to Velumix Cloud");
  } catch (err) {
    showToast(`Save failed: ${err.message}`);
  }
}

async function patchAssetInCloud(asset, patch) {
  if (!canEditBoard()) {
    showToast("Viewer role is read-only.");
    return;
  }
  const docId = asset._docId || asset.id;
  Object.assign(asset, patch);
  renderAll();
  try {
    await setDoc(doc(db, "workspaces", WORKSPACE_ID, "assets", docId), {
      ...patch,
      updatedAt: new Date().toISOString()
    }, { merge: true });
    showToast(`Updated ${asset.name}`);
  } catch (err) {
    showToast(`Save failed: ${err.message}`);
  }
}

function priorityClass(prio) {
  if (!prio) return "prio-p2";
  if (prio.startsWith("P0")) return "prio-p0";
  if (prio.startsWith("P1")) return "prio-p1";
  if (prio.startsWith("P2")) return "prio-p2";
  return "prio-p3";
}

function gameChipClass(game) {
  return game === "Dive" ? "chip-game-dive" : "chip-game-sc";
}

function parseChecklistStats(body) {
  const matches = String(body || "").match(/^[ \t]*[-*]\s+\[([ xX])\]/gm);
  if (!matches || matches.length === 0) return null;
  const done = matches.filter((m) => /\[[xX]\]/.test(m)).length;
  return { done, total: matches.length };
}

function sortedItems() {
  return [...itemsMap.values()].sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0));
}

function sortedAssets() {
  return [...assetsMap.values()].sort((a, b) => (Number(a._order) || 999) - (Number(b._order) || 999));
}

function populateFilters() {
  const areaEl = document.getElementById("areaFilter");
  const phaseEl = document.getElementById("phaseFilter");
  const prioEl = document.getElementById("priorityFilter");
  const prevArea = areaEl.value;
  const prevPhase = phaseEl.value;
  const prevPrio = prioEl.value;

  if (currentView === "kanban") {
    const items = sortedItems();
    const areas = [...new Set(items.map((i) => i.area).filter(Boolean))].sort();
    const phases = [...new Set(items.map((i) => i.phase).filter(Boolean))].sort();
    const prios = [...new Set(items.map((i) => i.priority).filter(Boolean))].sort();
    areaEl.innerHTML = `<option value="">All Areas</option>` + areas.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
    phaseEl.innerHTML = `<option value="">All Phases</option>` + phases.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
    prioEl.innerHTML = `<option value="">All Priorities</option>` + prios.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
  } else {
    const assets = sortedAssets();
    const cats = [...new Set(assets.map((a) => a.category).filter(Boolean))].sort();
    const stages = (boardMeta.stages || DEFAULT_STAGES).map((s) => s.id);
    const prios = [...new Set(assets.map((a) => a.priority).filter(Boolean))].sort();
    areaEl.innerHTML = `<option value="">All Categories</option>` + cats.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
    phaseEl.innerHTML = `<option value="">All Asset Stages</option>` + stages.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
    prioEl.innerHTML = `<option value="">All Priorities</option>` + prios.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
  }

  if ([...areaEl.options].some((o) => o.value === prevArea)) areaEl.value = prevArea;
  if ([...phaseEl.options].some((o) => o.value === prevPhase)) phaseEl.value = prevPhase;
  if ([...prioEl.options].some((o) => o.value === prevPrio)) prioEl.value = prevPrio;
}

function renderKpis() {
  const strip = document.getElementById("kpiStrip");
  if (currentView === "kanban") {
    const items = sortedItems();
    const total = items.length;
    const done = items.filter((i) => i.status === "Done").length;
    const ready = items.filter((i) => i.status === "Ready" || i.status === "In Progress").length;
    const qa = items.filter((i) => i.status === "In Review / QA").length;
    let tasksDone = 0, tasksTotal = 0;
    for (const it of items) {
      const st = parseChecklistStats(it.body);
      if (st) { tasksDone += st.done; tasksTotal += st.total; }
    }
    const pct = total ? Math.round((done / total) * 100) : 0;
    const m = boardMeta.metrics || {};
    strip.innerHTML = `
      <div class="kpi-card">
        <div class="kpi-label">Project Completion</div>
        <div class="kpi-value">${pct}% <span class="kpi-meta">${done}/${total} issues done</span></div>
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Ready &amp; Active</div>
        <div class="kpi-value" style="color:var(--azure)">${ready} <span class="kpi-meta">ready to execute</span></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Checklist Sub-Tasks</div>
        <div class="kpi-value" style="color:var(--amber)">${tasksDone}/${tasksTotal} <span class="kpi-meta">checked items</span></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Studio QA Queue</div>
        <div class="kpi-value" style="color:var(--purple)">${qa} <span class="kpi-meta">awaiting playtest</span></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Engine &amp; Test Suite</div>
        <div class="kpi-value" style="color:var(--mint)">${m.testsPassed || 455}/${m.testsTotal || 455} <span class="kpi-meta">${m.services || 54} services · ${m.definitions || 305} defs</span></div>
      </div>
    `;
  } else {
    const allAssets = sortedAssets();
    const assets = currentView === "designs" ? allAssets.filter((a) => a.designSpec) : allAssets;
    const total = assets.length;
    const shipped = assets.filter((a) => a.stage === "Wired & Shipped").length;
    const designed = assets.filter((a) => a.stage === "Designed in Kanban").length;
    const readyOnDisk = assets.filter((a) => a.stage === "Baked & QA Pass" || a.stage === "Modeled on Disk").length;
    const inStudioFix = assets.filter((a) => a.stage === "Imported in Studio").length;
    const unbuilt = assets.filter((a) => a.stage === "Missing / Unbuilt").length;
    const builtPct = total ? Math.round(((readyOnDisk + inStudioFix + shipped) / total) * 100) : 0;
    strip.innerHTML = `
      <div class="kpi-card">
        <div class="kpi-label">Velum Forge Rendered</div>
        <div class="kpi-value">${builtPct}% <span class="kpi-meta">${readyOnDisk + inStudioFix + shipped}/${total} modeled or baked</span></div>
        <div class="progress-track"><div class="progress-fill" style="width:${builtPct}%"></div></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Designed in Kanban</div>
        <div class="kpi-value" style="color:#ff6b9d">${designed} <span class="kpi-meta">ready for Velum Forge</span></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Baked 2K PBR</div>
        <div class="kpi-value" style="color:var(--cyan)">${readyOnDisk} <span class="kpi-meta">QA PASS 0E/0W</span></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">In Studio / Missing</div>
        <div class="kpi-value" style="color:var(--amber)">${inStudioFix} <span class="kpi-meta">+ ${unbuilt} unspec'd</span></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Wired &amp; Live</div>
        <div class="kpi-value" style="color:var(--mint)">${shipped} <span class="kpi-meta">verified in DataModel</span></div>
      </div>
    `;
  }
}

function getFilteredIssues() {
  const q = document.getElementById("searchInput").value.trim().toLowerCase();
  const game = document.getElementById("gameFilter").value;
  const area = document.getElementById("areaFilter").value;
  const phase = document.getElementById("phaseFilter").value;
  const prio = document.getElementById("priorityFilter").value;
  return sortedItems().filter((item) => {
    const itemGame = item.game || "Sun City RP";
    if (game && itemGame !== game) return false;
    if (area && item.area !== area) return false;
    if (phase && item.phase !== phase) return false;
    if (prio && item.priority !== prio) return false;
    if (q) {
      const hay = `#${item.number} ${item.title} ${item.body} ${item.area} ${item.phase} ${itemGame} ${item.assetStage || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function getFilteredAssets() {
  const q = document.getElementById("searchInput").value.trim().toLowerCase();
  const game = document.getElementById("gameFilter").value;
  const cat = document.getElementById("areaFilter").value;
  const stage = document.getElementById("phaseFilter").value;
  const prio = document.getElementById("priorityFilter").value;
  return sortedAssets().filter((a) => {
    if (game && a.game !== game) return false;
    if (cat && a.category !== cat) return false;
    if (stage && a.stage !== stage) return false;
    if (prio && a.priority !== prio) return false;
    if (q) {
      const hay = `${a.name} ${a.category} ${a.targetPath} ${a.diskPath} ${a.notes} ${a.game} ${a.stage} ${a.designSpec?.style || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderKanbanBoard() {
  const boardEl = document.getElementById("boardView");
  const matrixEl = document.getElementById("matrixView");
  boardEl.style.display = "grid";
  matrixEl.style.display = "none";
  boardEl.innerHTML = "";

  if (itemsMap.size === 0 && isOwner()) {
    boardEl.innerHTML = `
      <div class="empty-col" style="grid-column:1/-1;padding:42px 24px;">
        <strong style="color:var(--text-primary);font-size:15px;">Cloud Workspace Connected — Ready to Import Your Kanban Seed Bundle</strong>
        <p style="margin:8px 0 14px;">Click <strong>+ Invite Link / Team</strong> in the top bar and select <code>kanban/cloud-seed-bundle.json</code> to populate all 38 cards &amp; 20 Miami Building Designs.</p>
      </div>`;
    return;
  }

  const filtered = getFilteredIssues();
  const editable = canEditBoard();

  for (const col of boardMeta.columns || DEFAULT_COLUMNS) {
    const colItems = filtered.filter((item) => item.status === col.id);
    const colEl = document.createElement("div");
    colEl.className = "column";

    if (editable) {
      colEl.addEventListener("dragover", (e) => { e.preventDefault(); colEl.classList.add("drag-over"); });
      colEl.addEventListener("dragleave", () => colEl.classList.remove("drag-over"));
      colEl.addEventListener("drop", (e) => {
        e.preventDefault();
        colEl.classList.remove("drag-over");
        const docId = e.dataTransfer.getData("text/plain");
        const item = itemsMap.get(docId);
        if (item && item.status !== col.id) {
          patchItemInCloud(item, { status: col.id });
        }
      });
    }

    colEl.innerHTML = `
      <div class="column-header">
        <div class="column-title-wrap">
          <span class="col-dot" style="background:${col.accent}; box-shadow: 0 0 10px ${col.accent};"></span>
          <span class="column-title">${escapeHtml(col.label)}</span>
        </div>
        <span class="column-count">${colItems.length}</span>
      </div>
      <div class="column-desc">${escapeHtml(col.description)}</div>
      <div class="column-cards"></div>
    `;

    const wrap = colEl.querySelector(".column-cards");
    if (colItems.length === 0) {
      wrap.innerHTML = `<div class="empty-col">No cards</div>`;
    } else {
      for (const item of colItems) {
        const cardEl = document.createElement("article");
        cardEl.className = "card";
        cardEl.draggable = editable;
        if (editable) {
          cardEl.addEventListener("dragstart", (e) => {
            cardEl.classList.add("dragging");
            e.dataTransfer.setData("text/plain", item._docId);
          });
          cardEl.addEventListener("dragend", () => cardEl.classList.remove("dragging"));
        }
        cardEl.addEventListener("click", () => openIssueModal(item));

        const cl = parseChecklistStats(item.body);
        const clPct = cl ? Math.round((cl.done / cl.total) * 100) : 0;
        const game = item.game || "Sun City RP";
        const cover = normalizeRenderUrl(item.coverRender);
        const stageChip = item.assetStage && item.assetStage !== "N/A (Code/QA)"
          ? `<span class="chip chip-stage">${escapeHtml(item.assetStage)}</span>`
          : "";

        cardEl.innerHTML = `
          ${cover ? `<div class="card-thumb"><img src="${escapeHtml(cover)}" loading="lazy" alt="" /></div>` : ""}
          <div class="card-top">
            <span class="issue-num">${escapeHtml((item.repo || "SunCityRP").split("/").pop())} #${item.number || "NEW"}</span>
            <span class="priority-pill ${priorityClass(item.priority)}">${escapeHtml(item.priority)}</span>
          </div>
          <div class="card-title">${escapeHtml(item.title)}</div>
          ${cl ? `
            <div class="checklist-mini">
              <span>&#x2611; ${cl.done}/${cl.total}</span>
              <div class="checklist-mini-bar"><div class="checklist-mini-fill" style="width:${clPct}%"></div></div>
            </div>
          ` : ""}
          <div class="card-meta-row">
            <span class="chip ${gameChipClass(game)}">${escapeHtml(game)}</span>
            <span class="chip chip-area">${escapeHtml(item.area)}</span>
            ${stageChip}
          </div>
        `;
        wrap.appendChild(cardEl);
      }
    }
    boardEl.appendChild(colEl);
  }
}

function renderDesignsBoard() {
  const boardEl = document.getElementById("boardView");
  const matrixEl = document.getElementById("matrixView");
  boardEl.style.display = "grid";
  matrixEl.style.display = "none";
  boardEl.innerHTML = "";

  const phases = [
    { id: "Phase A — Starter Town", label: "Phase A · Ocean Drive & Calle Sol", accent: "#ff6b9d", desc: "P0 Starter District: South Beach, Ocean Drive, Calle Sol storefronts & Vice Customs" },
    { id: "Phase B — Marina & Port", label: "Phase B · Sun Bay Marina & Port", accent: "#00d4f0", desc: "Waterfront boatworks, freight warehouse & sanitation transfer depot" },
    { id: "Phase C — Civic & Skyline", label: "Phase C · Downtown & Brickell", accent: "#bf5af2", desc: "Walkable Hospital, Fire Station 01, City Hall, Bank, Transit & Brickell Towers" },
    { id: "Phase D — Estates & Coast", label: "Phase D · Star Island & Malibu", accent: "#ff9f0a", desc: "Club Malibu sunset beach pavilion, waterfront estates & coastal landmarks" }
  ];

  const filtered = getFilteredAssets().filter((a) => a.designSpec);
  for (const ph of phases) {
    const items = filtered.filter((a) => a.designSpec?.phase === ph.id);
    const colEl = document.createElement("div");
    colEl.className = "column";
    colEl.innerHTML = `
      <div class="column-header">
        <div class="column-title-wrap">
          <span class="col-dot" style="background:${ph.accent}; box-shadow: 0 0 10px ${ph.accent};"></span>
          <span class="column-title">${escapeHtml(ph.label)}</span>
        </div>
        <span class="column-count">${items.length}</span>
      </div>
      <div class="column-desc">${escapeHtml(ph.desc)}</div>
      <div class="column-cards"></div>
    `;
    const wrap = colEl.querySelector(".column-cards");
    if (items.length === 0) {
      wrap.innerHTML = `<div class="empty-col">No matching building designs</div>`;
    } else {
      for (const asset of items) {
        const ds = asset.designSpec;
        const hero = asset.renders?.[0] ? normalizeRenderUrl(asset.renders[0]) : "";
        const cardEl = document.createElement("article");
        cardEl.className = "card";
        cardEl.addEventListener("click", () => openAssetModal(asset));
        const swatches = (ds.palette || []).map((p) =>
          `<div style="flex:1;height:8px;border-radius:4px;background:${escapeHtml(p.hex)};border:1px solid rgba(255,255,255,0.2);" title="${escapeHtml(p.name)}: ${escapeHtml(p.hex)}"></div>`
        ).join("");
        cardEl.innerHTML = `
          ${hero ? `<div class="card-thumb"><img src="${escapeHtml(hero)}" loading="lazy" alt="${escapeHtml(asset.name)}" /></div>` : ""}
          <div style="display:flex;gap:5px;">${swatches}</div>
          <div class="card-top">
            <span class="chip chip-stage">${escapeHtml(asset.stage)}</span>
            <span class="priority-pill ${priorityClass(asset.priority)}">${escapeHtml(asset.priority)}</span>
          </div>
          <div class="card-title">${escapeHtml(asset.name)}</div>
          <div class="card-sub">${escapeHtml(ds.style)}</div>
          <div class="card-meta-row">
            <span class="chip">${ds.dimensions_m.length}×${ds.dimensions_m.width}×${ds.dimensions_m.height}m</span>
            <span class="chip">&le;${Math.round((ds.tri_budget_lod0 || 16000) / 1000)}k tris</span>
            <span class="chip">${(ds.variants || []).length} variants</span>
            ${ds.walkable_interior ? `<span class="chip" style="color:#7ef2c8;">Walk-In</span>` : ""}
          </div>
        `;
        wrap.appendChild(cardEl);
      }
    }
    boardEl.appendChild(colEl);
  }
}

function renderPipelineBoard() {
  const boardEl = document.getElementById("boardView");
  const matrixEl = document.getElementById("matrixView");
  boardEl.style.display = "grid";
  matrixEl.style.display = "none";
  boardEl.innerHTML = "";

  const filtered = getFilteredAssets();
  const editable = canEditBoard();
  for (const stage of boardMeta.stages || DEFAULT_STAGES) {
    const stageAssets = filtered.filter((a) => a.stage === stage.id);
    const colEl = document.createElement("div");
    colEl.className = "column";

    if (editable) {
      colEl.addEventListener("dragover", (e) => { e.preventDefault(); colEl.classList.add("drag-over"); });
      colEl.addEventListener("dragleave", () => colEl.classList.remove("drag-over"));
      colEl.addEventListener("drop", (e) => {
        e.preventDefault();
        colEl.classList.remove("drag-over");
        const docId = e.dataTransfer.getData("text/plain");
        const asset = assetsMap.get(docId);
        if (asset && asset.stage !== stage.id) {
          patchAssetInCloud(asset, { stage: stage.id });
        }
      });
    }

    colEl.innerHTML = `
      <div class="column-header">
        <div class="column-title-wrap">
          <span class="col-dot" style="background:${stage.accent}; box-shadow: 0 0 10px ${stage.accent};"></span>
          <span class="column-title">${escapeHtml(stage.label)}</span>
        </div>
        <span class="column-count">${stageAssets.length}</span>
      </div>
      <div class="column-desc">${escapeHtml(stage.description)}</div>
      <div class="column-cards"></div>
    `;

    const wrap = colEl.querySelector(".column-cards");
    if (stageAssets.length === 0) {
      wrap.innerHTML = `<div class="empty-col">No assets</div>`;
    } else {
      for (const asset of stageAssets) {
        const cardEl = document.createElement("article");
        cardEl.className = "card";
        cardEl.draggable = editable;
        if (editable) {
          cardEl.addEventListener("dragstart", (e) => {
            cardEl.classList.add("dragging");
            e.dataTransfer.setData("text/plain", asset._docId);
          });
          cardEl.addEventListener("dragend", () => cardEl.classList.remove("dragging"));
        }
        cardEl.addEventListener("click", () => openAssetModal(asset));

        const hero = asset.renders?.[0] ? normalizeRenderUrl(asset.renders[0]) : "";
        const ds = asset.designSpec;
        cardEl.innerHTML = `
          ${hero ? `<div class="card-thumb"><img src="${escapeHtml(hero)}" loading="lazy" alt="${escapeHtml(asset.name)}" /></div>` : ""}
          <div class="card-top">
            <span class="chip ${gameChipClass(asset.game)}">${escapeHtml(ds ? ds.district : asset.game)}</span>
            <span class="priority-pill ${priorityClass(asset.priority)}">${escapeHtml(asset.priority)}</span>
          </div>
          <div class="card-title">${escapeHtml(asset.name)}</div>
          <div class="card-sub">${escapeHtml(ds ? ds.style : asset.notes)}</div>
          <div class="card-meta-row">
            <span class="chip chip-area">${escapeHtml(asset.category)}</span>
            ${asset.renders?.length ? `<span class="chip" style="color:#8eeeff;">${asset.renders.length} renders</span>` : ""}
          </div>
        `;
        wrap.appendChild(cardEl);
      }
    }
    boardEl.appendChild(colEl);
  }
}

function renderMatrixView() {
  const boardEl = document.getElementById("boardView");
  const matrixEl = document.getElementById("matrixView");
  boardEl.style.display = "none";
  matrixEl.style.display = "block";

  const filtered = getFilteredAssets();
  const stageOpts = (boardMeta.stages || DEFAULT_STAGES).map((s) => s.id);
  const disabledAttr = canEditBoard() ? "" : "disabled";

  matrixEl.innerHTML = `
    <table class="matrix-table">
      <thead>
        <tr>
          <th>Preview</th>
          <th>Asset / Suite</th>
          <th>Game</th>
          <th>Category</th>
          <th>Pipeline Stage</th>
          <th>Priority</th>
          <th>Target Studio Path</th>
          <th>Audit Notes</th>
        </tr>
      </thead>
      <tbody>
        ${filtered.map((a) => {
          const hero = a.renders?.[0] ? normalizeRenderUrl(a.renders[0]) : "";
          return `
            <tr>
              <td>${hero ? `<img class="matrix-thumb" src="${escapeHtml(hero)}" alt="" data-open="${escapeHtml(a._docId)}" />` : `<span class="issue-num">Pending</span>`}</td>
              <td>
                <strong style="cursor:pointer;color:var(--text-primary);" data-open="${escapeHtml(a._docId)}">${escapeHtml(a.name)}</strong>
                ${a.diskPath ? `<div class="issue-num" style="margin-top:3px;">${escapeHtml(a.diskPath)}</div>` : ""}
              </td>
              <td><span class="chip ${gameChipClass(a.game)}">${escapeHtml(a.game)}</span></td>
              <td><span class="chip chip-area">${escapeHtml(a.category)}</span></td>
              <td>
                <select class="filter-select matrix-stage-sel" data-id="${escapeHtml(a._docId)}" ${disabledAttr}>
                  ${stageOpts.map((st) => `<option value="${escapeHtml(st)}" ${a.stage === st ? "selected" : ""}>${escapeHtml(st)}</option>`).join("")}
                </select>
              </td>
              <td><span class="priority-pill ${priorityClass(a.priority)}">${escapeHtml(a.priority)}</span></td>
              <td><span class="mono-path">${escapeHtml(a.targetPath || "—")}</span></td>
              <td style="max-width:340px;color:var(--text-secondary);">${escapeHtml(a.notes)}</td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;

  matrixEl.querySelectorAll("[data-open]").forEach((el) => {
    el.addEventListener("click", () => {
      const a = assetsMap.get(el.dataset.open);
      if (a) openAssetModal(a);
    });
  });

  matrixEl.querySelectorAll(".matrix-stage-sel").forEach((sel) => {
    sel.addEventListener("change", (e) => {
      const a = assetsMap.get(sel.dataset.id);
      if (a) patchAssetInCloud(a, { stage: e.target.value });
    });
  });
}

function renderAll() {
  renderKpis();
  if (currentView === "kanban") renderKanbanBoard();
  else if (currentView === "designs") renderDesignsBoard();
  else if (currentView === "pipeline") renderPipelineBoard();
  else renderMatrixView();
}

function buildSelectHtml(id, options, current) {
  const list = options.includes(current) ? options : [...options, current].filter(Boolean);
  const dis = canEditBoard() ? "" : "disabled";
  return `<select id="${id}" class="filter-select" style="width:100%;" ${dis}>
    ${list.map((o) => `<option value="${escapeHtml(o)}" ${o === current ? "selected" : ""}>${escapeHtml(o)}</option>`).join("")}
  </select>`;
}

function renderInteractiveBody(container, item) {
  const lines = String(item.body || "No description provided.").split(/\r?\n/);
  let taskIndex = 0;
  const dis = canEditBoard() ? "" : "disabled";
  container.innerHTML = lines.map((line) => {
    const m = line.match(/^([ \t]*[-*]\s+\[)([ xX])(\]\s*)(.*)$/);
    if (m) {
      const checked = m[2].toLowerCase() === "x";
      const idx = taskIndex++;
      const formatted = escapeHtml(m[4]).replace(/`([^`]+)`/g, "<code>$1</code>");
      return `<label class="task-row ${checked ? "done" : ""}" data-task-idx="${idx}">
        <input type="checkbox" ${checked ? "checked" : ""} data-task-idx="${idx}" ${dis} />
        <span>${formatted}</span>
      </label>`;
    }
    if (/^###\s+/.test(line)) {
      return `<div style="font-weight:700;color:var(--text-primary);margin:10px 0 4px;">${escapeHtml(line.replace(/^###\s+/, ""))}</div>`;
    }
    if (!line.trim()) return `<div style="height:6px;"></div>`;
    return `<div>${escapeHtml(line).replace(/`([^`]+)`/g, "<code>$1</code>")}</div>`;
  }).join("");

  if (canEditBoard()) {
    container.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener("change", () => {
        const targetIdx = Number(cb.dataset.taskIdx);
        let cur = 0;
        const updatedLines = String(item.body || "").split(/\r?\n/).map((line) => {
          const m = line.match(/^([ \t]*[-*]\s+\[)([ xX])(\]\s*.*)$/);
          if (!m) return line;
          if (cur++ === targetIdx) return `${m[1]}${cb.checked ? "x" : " "}${m[3]}`;
          return line;
        });
        patchItemInCloud(item, { body: updatedLines.join("\n") });
        renderInteractiveBody(container, item);
      });
    });
  }
}

function openIssueModal(item) {
  activeIssue = item;
  document.getElementById("modalIssueNum").textContent = `${item.repo || "velumix/SunCityRP"} #${item.number || "CARD"} · ${item.state || "OPEN"}`;
  document.getElementById("modalTitle").textContent = item.title;
  document.getElementById("modalGithubLink").href = item.url || "https://github.com/users/velumix/projects/1";

  const coverWrap = document.getElementById("issueCoverWrap");
  const cover = normalizeRenderUrl(item.coverRender);
  if (cover) {
    coverWrap.style.display = "flex";
    document.getElementById("issueCoverImg").src = cover;
  } else {
    coverWrap.style.display = "none";
  }

  const fo = boardMeta.fieldOptions || {};
  const statusOpts = fo.status || DEFAULT_COLUMNS.map((c) => c.id);
  const prioOpts = fo.priority || ["P0 Critical", "P1 High", "P2 Medium", "P3 Low"];
  const gameOpts = fo.game || ["Sun City RP", "Dive", "Observatory"];
  const areaOpts = fo.area || ["Water & Boats", "Gameplay & Jobs", "Weather & World", "UI & SunOS", "Backend & Ops", "QA & Release"];
  const stageOpts = fo.assetStage || ["N/A (Code/QA)", ...DEFAULT_STAGES.map((s) => s.id)];

  const grid = document.getElementById("issueFieldGrid");
  grid.innerHTML = `
    <div class="field-box"><label>Column Status</label>${buildSelectHtml("issStatusSel", statusOpts, item.status)}</div>
    <div class="field-box"><label>Priority</label>${buildSelectHtml("issPrioSel", prioOpts, item.priority)}</div>
    <div class="field-box"><label>Game</label>${buildSelectHtml("issGameSel", gameOpts, item.game || "Sun City RP")}</div>
    <div class="field-box"><label>Area</label>${buildSelectHtml("issAreaSel", areaOpts, item.area)}</div>
    <div class="field-box"><label>Asset Stage</label>${buildSelectHtml("issStageSel", stageOpts, item.assetStage || "N/A (Code/QA)")}</div>
  `;

  if (canEditBoard()) {
    grid.querySelector("#issStatusSel").addEventListener("change", (e) => patchItemInCloud(item, { status: e.target.value }));
    grid.querySelector("#issPrioSel").addEventListener("change", (e) => patchItemInCloud(item, { priority: e.target.value }));
    grid.querySelector("#issGameSel").addEventListener("change", (e) => patchItemInCloud(item, { game: e.target.value }));
    grid.querySelector("#issAreaSel").addEventListener("change", (e) => patchItemInCloud(item, { area: e.target.value }));
    grid.querySelector("#issStageSel").addEventListener("change", (e) => patchItemInCloud(item, { assetStage: e.target.value }));
  }

  renderInteractiveBody(document.getElementById("modalBody"), item);
  document.getElementById("issueModalBackdrop").classList.add("open");
}

function openAssetModal(asset) {
  activeAsset = asset;
  document.getElementById("assetModalMeta").textContent = `${asset.game} · ${asset.category}`;
  document.getElementById("assetModalTitle").textContent = asset.name;
  const notesEl = document.getElementById("assetNotesInput");
  notesEl.value = asset.notes || "";
  notesEl.disabled = !canEditBoard();
  document.getElementById("saveAssetBtn").style.display = canEditBoard() ? "inline-flex" : "none";
  document.getElementById("assetPathsInfo").textContent =
    `Studio: ${asset.targetPath || "TBD"}${asset.diskPath ? `  |  Disk: ${asset.diskPath}` : ""}`;

  const galWrap = document.getElementById("assetGalleryWrap");
  const mainImg = document.getElementById("assetGalleryMain");
  const strip = document.getElementById("assetGalleryStrip");
  const renders = (asset.renders || []).map(normalizeRenderUrl).filter(Boolean);
  if (renders.length > 0) {
    galWrap.style.display = "flex";
    mainImg.src = renders[0];
    strip.innerHTML = renders.map((r, idx) =>
      `<img class="gallery-thumb ${idx === 0 ? "active" : ""}" src="${escapeHtml(r)}" data-src="${escapeHtml(r)}" alt="" />`
    ).join("");
    strip.querySelectorAll(".gallery-thumb").forEach((th) => {
      th.addEventListener("click", () => {
        mainImg.src = th.dataset.src;
        strip.querySelectorAll(".gallery-thumb").forEach((x) => x.classList.remove("active"));
        th.classList.add("active");
      });
    });
  } else {
    galWrap.style.display = "none";
  }

  const bpWrap = document.getElementById("assetBlueprintWrap");
  if (asset.designSpec) {
    const ds = asset.designSpec;
    const d = ds.dimensions_m || { length: 16, width: 12, height: 6 };
    const studs = `${Math.round(d.length / 0.28)} × ${Math.round(d.width / 0.28)} × ${Math.round(d.height / 0.28)} studs`;
    bpWrap.style.display = "block";
    bpWrap.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:10px;">
        <strong style="color:var(--text-primary);font-size:13.5px;">Architectural Design Blueprint (${escapeHtml(ds.phase)})</strong>
        <span class="chip" style="color:#7ef2c8;">${d.length}m × ${d.width}m × ${d.height}m (${studs}) · &le;${(ds.tri_budget_lod0 || 16000).toLocaleString()} LOD0 tris</span>
      </div>
      <div style="margin-bottom:10px;color:var(--text-primary);"><strong>Miami Style:</strong> ${escapeHtml(ds.style)}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:8px;margin-bottom:12px;">
        ${(ds.palette || []).map((p) => `
          <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);">
            <span style="width:20px;height:20px;border-radius:5px;background:${escapeHtml(p.hex)};border:1px solid rgba(255,255,255,0.25);flex-shrink:0;"></span>
            <div style="font-size:11px;line-height:1.25;">
              <div style="color:var(--text-primary);font-weight:600;">${escapeHtml(p.name)}</div>
              <div style="font-family:'JetBrains Mono',monospace;color:var(--text-muted);">${escapeHtml(p.hex)}</div>
            </div>
          </div>
        `).join("")}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:10px;">
        <div>
          <div style="font-weight:700;color:var(--text-primary);margin-bottom:5px;">Key Architectural &amp; RP Features</div>
          ${(ds.key_features || []).map((f) => `<div style="font-size:12px;margin-bottom:4px;">• ${escapeHtml(f)}</div>`).join("")}
        </div>
        <div>
          <div style="font-weight:700;color:var(--text-primary);margin-bottom:5px;">4 Velum Forge Variants</div>
          ${(ds.variants || []).map((v) => `<div style="font-size:12px;margin-bottom:4px;"><code>${escapeHtml(v.id)}</code> <strong>${escapeHtml(v.label)}:</strong> ${escapeHtml(v.summary)}</div>`).join("")}
        </div>
      </div>
      <div>
        <strong style="color:var(--text-primary);">build123d Precision CAD Hardware:</strong>
        ${(ds.cad_hardware || []).map((h) => `<span class="chip" style="margin-left:5px;">${escapeHtml(h)}</span>`).join("")}
      </div>
    `;
  } else {
    bpWrap.style.display = "none";
  }

  const stageOpts = (boardMeta.stages || DEFAULT_STAGES).map((s) => s.id);
  const prioOpts = ["P0 Critical", "P1 High", "P2 Medium", "P3 Low"];
  const grid = document.getElementById("assetFieldGrid");
  grid.innerHTML = `
    <div class="field-box"><label>3D Pipeline Stage</label>${buildSelectHtml("astStageSel", stageOpts, asset.stage)}</div>
    <div class="field-box"><label>Priority</label>${buildSelectHtml("astPrioSel", prioOpts, asset.priority)}</div>
  `;
  if (canEditBoard()) {
    grid.querySelector("#astStageSel").addEventListener("change", (e) => patchAssetInCloud(asset, { stage: e.target.value }));
    grid.querySelector("#astPrioSel").addEventListener("change", (e) => patchAssetInCloud(asset, { priority: e.target.value }));
  }

  document.getElementById("assetModalBackdrop").classList.add("open");
}

async function refreshTeamModal() {
  if (!isOwner()) return;
  const invWrap = document.getElementById("invitesListWrap");
  const memWrap = document.getElementById("membersListWrap");
  invWrap.innerHTML = `<div class="issue-num">Loading invites...</div>`;
  memWrap.innerHTML = `<div class="issue-num">Loading members...</div>`;

  const baseUrl = window.location.origin + window.location.pathname;

  try {
    const invSnap = await getDocs(collection(db, "workspaces", WORKSPACE_ID, "invites"));
    const invites = [];
    invSnap.forEach((d) => invites.push({ id: d.id, ...d.data() }));
    const activeInvites = invites.filter((i) => i.active);
    if (activeInvites.length === 0) {
      invWrap.innerHTML = `<div class="issue-num">No active invite links yet. Click "Generate &amp; Copy Shareable Invite Link" above.</div>`;
    } else {
      invWrap.innerHTML = activeInvites.map((inv) => {
        const url = `${baseUrl}?invite=${encodeURIComponent(inv.code || inv.id)}`;
        const uses = inv.maxUses ? `${inv.usedCount || 0}/${inv.maxUses} uses` : `${inv.usedCount || 0} uses (unlimited)`;
        return `
          <div class="invite-row">
            <div>
              <strong style="font-size:12.5px;">${escapeHtml(inv.label || "Teammate Invite")}</strong>
              <span class="role-badge" style="margin-left:6px;">${escapeHtml(inv.role)}</span>
              <span class="issue-num" style="margin-left:8px;">${escapeHtml(uses)}</span>
            </div>
            <div style="display:flex;gap:6px;">
              <button class="btn" data-copy-inv="${escapeHtml(url)}" style="padding:5px 10px;font-size:11.5px;">Copy Link</button>
              <button class="btn btn-danger" data-revoke-inv="${escapeHtml(inv.id)}" style="padding:5px 10px;font-size:11.5px;">Revoke</button>
            </div>
          </div>
        `;
      }).join("");

      invWrap.querySelectorAll("[data-copy-inv]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          await navigator.clipboard.writeText(btn.dataset.copyInv);
          showToast("Invite link copied to clipboard!");
        });
      });
      invWrap.querySelectorAll("[data-revoke-inv]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          await updateDoc(doc(db, "workspaces", WORKSPACE_ID, "invites", btn.dataset.revokeInv), { active: false });
          showToast("Invite link revoked");
          refreshTeamModal();
        });
      });
    }

    const memSnap = await getDocs(collection(db, "workspaces", WORKSPACE_ID, "members"));
    const members = [];
    memSnap.forEach((d) => members.push({ id: d.id, ...d.data() }));
    memWrap.innerHTML = members.map((m) => {
      const isSelf = m.uid === currentUser.uid;
      return `
        <div class="member-row">
          <div style="display:flex;align-items:center;gap:10px;">
            ${m.photoURL ? `<img class="user-avatar" src="${escapeHtml(m.photoURL)}" alt="" />` : `<div class="user-avatar"></div>`}
            <div>
              <div style="font-size:12.5px;font-weight:600;">${escapeHtml(m.displayName || m.email)}</div>
              <div class="issue-num">${escapeHtml(m.email)}</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            ${isSelf
              ? `<span class="role-badge owner">OWNER (YOU)</span>`
              : `
                <select class="filter-select mem-role-sel" data-uid="${escapeHtml(m.uid)}" style="padding:5px 10px;font-size:11.5px;">
                  <option value="editor" ${m.role === "editor" ? "selected" : ""}>Editor</option>
                  <option value="viewer" ${m.role === "viewer" ? "selected" : ""}>Viewer</option>
                </select>
                <button class="btn btn-danger" data-remove-uid="${escapeHtml(m.uid)}" style="padding:5px 10px;font-size:11.5px;">Remove</button>
              `
            }
          </div>
        </div>
      `;
    }).join("");

    memWrap.querySelectorAll(".mem-role-sel").forEach((sel) => {
      sel.addEventListener("change", async () => {
        await updateDoc(doc(db, "workspaces", WORKSPACE_ID, "members", sel.dataset.uid), { role: sel.value });
        showToast("Updated member role");
      });
    });
    memWrap.querySelectorAll("[data-remove-uid]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await deleteDoc(doc(db, "workspaces", WORKSPACE_ID, "members", btn.dataset.removeUid));
        showToast("Removed member access");
        refreshTeamModal();
      });
    });
  } catch (err) {
    invWrap.innerHTML = `<div class="issue-num">Error loading team: ${escapeHtml(err.message)}</div>`;
  }
}

async function importSeedBundleJson(rawJson) {
  const parsed = JSON.parse(rawJson);
  const board = parsed.boardData || parsed;
  const catalog = parsed.assetCatalog || { stages: DEFAULT_STAGES, assets: [] };

  const ops = [];
  ops.push({
    ref: doc(db, "workspaces", WORKSPACE_ID, "meta", "board"),
    data: {
      projectTitle: board.projectTitle || "Velumix Studio Roadmap",
      projectUrl: board.projectUrl || "https://github.com/users/velumix/projects/1",
      repoUrl: board.repoUrl || "https://github.com/velumix/SunCityRP",
      diveRepoUrl: board.diveRepoUrl || "https://github.com/velumix/Dive",
      fieldOptions: board.fieldOptions || {},
      metrics: board.metrics || {},
      columns: board.columns || DEFAULT_COLUMNS,
      stages: catalog.stages || DEFAULT_STAGES,
      updatedAt: new Date().toISOString()
    }
  });

  for (const item of board.items || []) {
    const id = docIdForItem(item);
    ops.push({
      ref: doc(db, "workspaces", WORKSPACE_ID, "items", id),
      data: {
        ...item,
        coverRender: normalizeRenderUrl(item.coverRender)
      }
    });
  }

  (catalog.assets || []).forEach((asset, idx) => {
    ops.push({
      ref: doc(db, "workspaces", WORKSPACE_ID, "assets", asset.id),
      data: {
        ...asset,
        _order: idx,
        renders: (asset.renders || []).map(normalizeRenderUrl)
      }
    });
  });

  for (let i = 0; i < ops.length; i += 350) {
    const batch = writeBatch(db);
    for (const op of ops.slice(i, i + 350)) {
      batch.set(op.ref, op.data, { merge: true });
    }
    await batch.commit();
  }
  showToast(`Imported ${board.items?.length || 0} cards & ${catalog.assets?.length || 0} 3D assets to Cloud!`);
}

function wireUiEvents() {
  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => document.getElementById(btn.dataset.close).classList.remove("open"));
  });
  document.querySelectorAll(".modal-backdrop").forEach((bd) => {
    bd.addEventListener("click", (e) => { if (e.target === bd) bd.classList.remove("open"); });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") document.querySelectorAll(".modal-backdrop.open").forEach((bd) => bd.classList.remove("open"));
  });

  document.querySelectorAll(".view-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".view-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      currentView = tab.dataset.view;
      populateFilters();
      renderAll();
    });
  });

  ["searchInput", "gameFilter", "areaFilter", "phaseFilter", "priorityFilter"].forEach((id) => {
    document.getElementById(id).addEventListener("input", renderAll);
    document.getElementById(id).addEventListener("change", renderAll);
  });

  document.getElementById("saveAssetBtn").addEventListener("click", () => {
    if (!activeAsset) return;
    patchAssetInCloud(activeAsset, { notes: document.getElementById("assetNotesInput").value });
  });

  document.getElementById("newCardBtn").addEventListener("click", () => {
    if (!canEditBoard()) { showToast("Viewer role is read-only."); return; }
    document.getElementById("newCardKind").value = currentView === "kanban" ? "issue" : "asset";
    document.getElementById("newCardTitle").value = "";
    document.getElementById("newCardBody").value = "";
    document.getElementById("newCardStatusMsg").textContent = "";
    document.getElementById("newModalBackdrop").classList.add("open");
  });

  document.getElementById("submitNewCardBtn").addEventListener("click", async () => {
    if (!canEditBoard()) return;
    const kind = document.getElementById("newCardKind").value;
    const game = document.getElementById("newCardGame").value;
    const priority = document.getElementById("newCardPriority").value;
    const area = document.getElementById("newCardArea").value;
    const title = document.getElementById("newCardTitle").value.trim();
    const body = document.getElementById("newCardBody").value.trim();
    const statusMsg = document.getElementById("newCardStatusMsg");
    if (!title) { statusMsg.textContent = "Please enter a title."; return; }

    try {
      if (kind === "issue") {
        const nextNum = Math.max(38, ...sortedItems().map((i) => Number(i.number) || 0)) + 1;
        const id = `velumix__SunCityRP#${nextNum}`;
        await setDoc(doc(db, "workspaces", WORKSPACE_ID, "items", id), {
          id: `velumix/SunCityRP#${nextNum}`,
          repo: game === "Dive" ? "velumix/Dive" : "velumix/SunCityRP",
          number: nextNum,
          title,
          body,
          state: "OPEN",
          status: "Ready",
          priority,
          area,
          phase: "Vertical Slice",
          game,
          assetStage: "Designed in Kanban",
          updatedAt: new Date().toISOString()
        });
      } else {
        const id = `custom_${Date.now()}`;
        await setDoc(doc(db, "workspaces", WORKSPACE_ID, "assets", id), {
          id,
          name: title,
          notes: body,
          game,
          category: area,
          stage: "Designed in Kanban",
          priority,
          targetPath: "",
          diskPath: "",
          renders: [],
          _order: 0,
          updatedAt: new Date().toISOString()
        });
      }
      document.getElementById("newModalBackdrop").classList.remove("open");
      showToast("Created card in Velumix Cloud!");
    } catch (err) {
      statusMsg.textContent = err.message;
    }
  });

  document.getElementById("teamBtn").addEventListener("click", () => {
    document.getElementById("teamModalBackdrop").classList.add("open");
    refreshTeamModal();
  });

  document.getElementById("createInviteBtn").addEventListener("click", async () => {
    if (!isOwner()) return;
    const role = document.getElementById("inviteRoleSel").value;
    const label = document.getElementById("inviteLabelInput").value.trim() || `${role.toUpperCase()} Invite`;
    const expDays = Number(document.getElementById("inviteExpirySel").value);
    const maxUsesVal = Number(document.getElementById("inviteMaxUsesSel").value);
    const code = generateCryptoInviteCode();

    const expiresAt = expDays > 0
      ? Timestamp.fromMillis(Date.now() + expDays * 86400 * 1000)
      : null;
    const maxUses = maxUsesVal > 0 ? maxUsesVal : null;

    await setDoc(doc(db, "workspaces", WORKSPACE_ID, "invites", code), {
      code,
      role: role === "editor" ? "editor" : "viewer",
      label,
      active: true,
      createdBy: currentUser.uid,
      createdByEmail: currentUser.email || "",
      createdAt: serverTimestamp(),
      expiresAt,
      maxUses,
      usedCount: 0
    });

    const shareUrl = `${window.location.origin}${window.location.pathname}?invite=${encodeURIComponent(code)}`;
    document.getElementById("latestInviteUrlInput").value = shareUrl;
    try {
      await navigator.clipboard.writeText(shareUrl);
      showToast("Invite link created & copied to clipboard!");
    } catch {
      showToast("Invite link created! Copy it from the box.");
    }
    refreshTeamModal();
  });

  document.getElementById("seedBundleFileInput").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      await importSeedBundleJson(text);
      refreshTeamModal();
    } catch (err) {
      showToast(`Import failed: ${err.message}`);
    } finally {
      e.target.value = "";
    }
  });

  document.getElementById("saveFirebaseConfigBtn").addEventListener("click", () => {
    try {
      saveLocalFirebaseConfig(document.getElementById("firebaseConfigInput").value);
      window.location.reload();
    } catch (err) {
      document.getElementById("authStatusMsg").textContent = err.message;
    }
  });
}

async function boot() {
  wireUiEvents();
  const pendingInvite = captureUrlInvite();
  if (pendingInvite) {
    document.getElementById("authInviteBanner").style.display = "block";
  }

  const cfg = loadFirebaseConfig();
  if (!cfg) {
    document.getElementById("firebaseSetupPanel").style.display = "flex";
    document.getElementById("googleSignInBtn").disabled = true;
    document.getElementById("authStatusMsg").textContent = "Waiting for Firebase project connection...";
    return;
  }

  const app = initializeApp(cfg);
  auth = getAuth(app);
  db = getFirestore(app);

  getRedirectResult(auth).catch(() => {});

  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  document.getElementById("googleSignInBtn").addEventListener("click", async () => {
    const statusEl = document.getElementById("authStatusMsg");
    statusEl.textContent = "Opening Google Sign-In...";
    try {
      await signInWithPopup(auth, provider);
    } catch (err) {
      if (err?.code === "auth/popup-blocked") {
        await signInWithRedirect(auth, provider);
      } else {
        statusEl.textContent = `Google Sign-In error: ${err.message}`;
      }
    }
  });

  const handleSignOut = async () => {
    stopRealtimeListeners();
    await signOut(auth);
  };
  document.getElementById("signOutBtn").addEventListener("click", handleSignOut);
  document.getElementById("restrictedSignOutBtn").addEventListener("click", handleSignOut);

  document.getElementById("redeemManualInviteBtn").addEventListener("click", async () => {
    if (!currentUser) return;
    const raw = document.getElementById("manualInviteInput").value;
    const statusEl = document.getElementById("authStatusMsg");
    try {
      statusEl.textContent = "Verifying invite link...";
      currentRole = await redeemInviteCode(currentUser, raw);
      enterAppShell(currentUser, currentRole);
      showToast(`Joined Velumix Studio as ${currentRole.toUpperCase()}!`);
    } catch (err) {
      statusEl.textContent = err.message;
    }
  });

  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    const statusEl = document.getElementById("authStatusMsg");

    if (!user) {
      stopRealtimeListeners();
      document.getElementById("appShell").style.display = "none";
      document.getElementById("authGate").style.display = "flex";
      document.getElementById("authSignInPanel").style.display = "flex";
      document.getElementById("authRestrictedPanel").style.display = "none";
      statusEl.textContent = "Sign in with Google to access Velumix Studio.";
      return;
    }

    statusEl.textContent = `Verifying access for ${user.email}...`;
    try {
      const emailLower = (user.email || "").toLowerCase();
      if (emailLower === OWNER_EMAIL.toLowerCase() && user.emailVerified) {
        currentRole = await ensureBootstrapOwner(user);
        clearPendingInvite();
        enterAppShell(user, currentRole);
        return;
      }

      const memSnap = await getDoc(doc(db, "workspaces", WORKSPACE_ID, "members", user.uid));
      if (memSnap.exists()) {
        currentRole = memSnap.data().role || "viewer";
        clearPendingInvite();
        enterAppShell(user, currentRole);
        return;
      }

      const inv = captureUrlInvite();
      if (inv) {
        currentRole = await redeemInviteCode(user, inv);
        enterAppShell(user, currentRole);
        showToast(`Invite accepted! Welcome to Velumix Studio (${currentRole}).`);
        return;
      }

      // Signed in, but no invite yet
      document.getElementById("appShell").style.display = "none";
      document.getElementById("authGate").style.display = "flex";
      document.getElementById("authSignInPanel").style.display = "none";
      document.getElementById("authRestrictedPanel").style.display = "flex";
      document.getElementById("restrictedUserEmail").textContent = user.email || user.uid;
      statusEl.textContent = "Ask the workspace owner for a shareable invite link.";
    } catch (err) {
      document.getElementById("authSignInPanel").style.display = "none";
      document.getElementById("authRestrictedPanel").style.display = "flex";
      document.getElementById("restrictedUserEmail").textContent = user.email || user.uid;
      statusEl.textContent = err.message;
    }
  });
}

function enterAppShell(user, role) {
  document.getElementById("authGate").style.display = "none";
  document.getElementById("appShell").style.display = "flex";
  document.getElementById("userName").textContent = user.displayName || user.email || "Member";
  const av = document.getElementById("userAvatar");
  if (user.photoURL) {
    av.src = user.photoURL;
    av.style.display = "block";
  } else {
    av.style.display = "none";
  }
  const rb = document.getElementById("userRoleBadge");
  rb.textContent = role.toUpperCase();
  rb.className = `role-badge ${role === "owner" ? "owner" : ""}`;
  document.getElementById("teamBtn").style.display = role === "owner" ? "inline-flex" : "none";
  document.getElementById("newCardBtn").style.display = (role === "owner" || role === "editor") ? "inline-flex" : "none";
  startRealtimeListeners();
}

boot();
