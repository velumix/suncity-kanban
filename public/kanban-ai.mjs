#!/usr/bin/env node
/**
 * Velumix Studio Kanban — Zero-Dependency AI Agent CLI (`kanban-ai.mjs`)
 * Lets any AI coding agent (Antigravity, Claude Code, Cursor, Codex) inspect and update
 * the live Google-authenticated Velumix Kanban & Miami 3D Building Designs over Firestore REST.
 *
 * Setup (one time after signing in via Google invite link at https://velumix.github.io/suncity-kanban/):
 *   1. Click "AI Agent Kit" in the Kanban top bar -> click "Copy .kanban-ai.json"
 *   2. Save it to `.kanban-ai.json` in your working folder (or `~/.kanban-ai.json`)
 *   3. Run:
 *        node kanban-ai.mjs status
 *        node kanban-ai.mjs list-cards --status "Ready"
 *        node kanban-ai.mjs list-designs --stage "Designed in Kanban"
 *        node kanban-ai.mjs move-card 38 "In Progress"
 *        node kanban-ai.mjs update-design coastal_trauma_hospital --stage "Baked & QA Pass" --notes "QA PASS 0E/0W"
 *        node kanban-ai.mjs create-card --title "[Phase C] Wire Hospital Interior" --area "Miami Architecture"
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function loadSessionConfig() {
  const envPath = process.env.KANBAN_AI_CONFIG;
  const candidates = [
    envPath,
    path.join(process.cwd(), ".kanban-ai.json"),
    path.join(os.homedir(), ".kanban-ai.json")
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
      if (cfg.apiKey && cfg.projectId && cfg.refreshToken) return cfg;
    }
  }
  throw new Error(
    "Missing .kanban-ai.json! Sign in at https://velumix.github.io/suncity-kanban/, click 'AI Agent Kit' in the top bar, and save '.kanban-ai.json' to your workspace or home directory."
  );
}

async function fetchIdToken(cfg) {
  const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(cfg.apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: cfg.refreshToken
    })
  });
  const data = await res.json();
  if (!res.ok || !data.id_token) {
    throw new Error(`Firebase token exchange failed: ${data.error?.message || res.statusText}`);
  }
  return data.id_token;
}

function fromFsValue(v) {
  if (!v || typeof v !== "object") return null;
  if ("nullValue" in v) return null;
  if ("booleanValue" in v) return Boolean(v.booleanValue);
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("stringValue" in v) return v.stringValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fromFsValue);
  if ("mapValue" in v) {
    const out = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) {
      out[k] = fromFsValue(val);
    }
    return out;
  }
  return null;
}

function toFsValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === "boolean") return { booleanValue: val };
  if (typeof val === "number") {
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  }
  if (typeof val === "string") return { stringValue: val };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFsValue) } };
  if (typeof val === "object") {
    const fields = {};
    for (const [k, v] of Object.entries(val)) {
      if (v !== undefined) fields[k] = toFsValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function docToJs(docObj) {
  const out = {};
  for (const [k, v] of Object.entries(docObj.fields || {})) {
    out[k] = fromFsValue(v);
  }
  out._docId = docObj.name.split("/").pop();
  return out;
}

function baseUrl(cfg) {
  const ws = cfg.workspaceId || "velumix";
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}/databases/(default)/documents/workspaces/${encodeURIComponent(ws)}`;
}

async function listCollection(cfg, token, subcol) {
  const docs = [];
  let pageToken = "";
  do {
    const url = new URL(`${baseUrl(cfg)}/${subcol}`);
    url.searchParams.set("pageSize", "200");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json();
    if (!res.ok) throw new Error(`Firestore GET ${subcol} failed: ${body.error?.message || res.statusText}`);
    for (const d of body.documents || []) docs.push(docToJs(d));
    pageToken = body.nextPageToken || "";
  } while (pageToken);
  return docs;
}

async function patchDoc(cfg, token, subcol, docId, patchObj) {
  const url = new URL(`${baseUrl(cfg)}/${subcol}/${encodeURIComponent(docId)}`);
  const fields = {};
  for (const [k, v] of Object.entries(patchObj)) {
    url.searchParams.append("updateMask.fieldPaths", k);
    fields[k] = toFsValue(v);
  }
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ fields })
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Firestore PATCH ${subcol}/${docId} failed: ${body.error?.message || res.statusText}`);
  return docToJs(body);
}

function parseFlags(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[k] = next;
        i++;
      } else {
        flags[k] = true;
      }
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

async function main() {
  const [cmd = "status", ...rest] = process.argv.slice(2);
  const { pos, flags } = parseFlags(rest);
  const cfg = loadSessionConfig();
  const token = await fetchIdToken(cfg);

  if (cmd === "status") {
    const [items, assets] = await Promise.all([
      listCollection(cfg, token, "items"),
      listCollection(cfg, token, "assets")
    ]);
    const byCol = {};
    for (const i of items) byCol[i.status] = (byCol[i.status] || 0) + 1;
    const byStage = {};
    for (const a of assets) byStage[a.stage] = (byStage[a.stage] || 0) + 1;
    console.log(JSON.stringify({
      workspace: cfg.workspaceId || "velumix",
      signedInAs: cfg.email,
      totalCards: items.length,
      cardsByColumn: byCol,
      totalAssets: assets.length,
      miamiDesignsCount: assets.filter((a) => a.designSpec).length,
      assetsByStage: byStage
    }, null, 2));
    return;
  }

  if (cmd === "list-cards") {
    let items = await listCollection(cfg, token, "items");
    items.sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0));
    if (flags.status) items = items.filter((i) => i.status.toLowerCase() === String(flags.status).toLowerCase());
    if (flags.game) items = items.filter((i) => (i.game || "").toLowerCase() === String(flags.game).toLowerCase());
    console.log(JSON.stringify(items.map((i) => ({
      number: i.number,
      id: i.id || i._docId,
      status: i.status,
      priority: i.priority,
      area: i.area,
      game: i.game,
      assetStage: i.assetStage,
      title: i.title
    })), null, 2));
    return;
  }

  if (cmd === "get-card") {
    const target = String(pos[0] || "").trim();
    if (!target) throw new Error("Usage: node kanban-ai.mjs get-card <numberOrId>");
    const items = await listCollection(cfg, token, "items");
    const found = items.find((i) => String(i.number) === target || i.id === target || i._docId === target);
    if (!found) throw new Error(`Card not found: ${target}`);
    console.log(JSON.stringify(found, null, 2));
    return;
  }

  if (cmd === "move-card" || cmd === "update-card") {
    const target = String(pos[0] || "").trim();
    const statusArg = cmd === "move-card" ? pos[1] : flags.status;
    if (!target) throw new Error(`Usage: node kanban-ai.mjs ${cmd} <numberOrId> [status]`);
    const items = await listCollection(cfg, token, "items");
    const found = items.find((i) => String(i.number) === target || i.id === target || i._docId === target);
    if (!found) throw new Error(`Card not found: ${target}`);
    const patch = { updatedAt: new Date().toISOString() };
    if (statusArg) patch.status = String(statusArg);
    if (flags.body) patch.body = String(flags.body);
    if (flags.priority) patch.priority = String(flags.priority);
    if (flags["asset-stage"]) patch.assetStage = String(flags["asset-stage"]);
    if (flags.title) patch.title = String(flags.title);
    const updated = await patchDoc(cfg, token, "items", found._docId, patch);
    console.log(JSON.stringify({ ok: true, id: updated.id || updated._docId, status: updated.status, title: updated.title }, null, 2));
    return;
  }

  if (cmd === "create-card") {
    const title = String(flags.title || "").trim();
    if (!title) throw new Error("Usage: node kanban-ai.mjs create-card --title \"...\" [--body \"...\"] [--area \"...\"] [--priority \"P1 High\"]");
    const items = await listCollection(cfg, token, "items");
    const nextNum = Math.max(38, ...items.map((i) => Number(i.number) || 0)) + 1;
    const game = String(flags.game || "Sun City RP");
    const docId = `velumix__SunCityRP#${nextNum}`;
    const created = await patchDoc(cfg, token, "items", docId, {
      id: `velumix/SunCityRP#${nextNum}`,
      repo: game === "Dive" ? "velumix/Dive" : "velumix/SunCityRP",
      number: nextNum,
      title,
      body: String(flags.body || ""),
      state: "OPEN",
      status: String(flags.status || "Ready"),
      priority: String(flags.priority || "P1 High"),
      area: String(flags.area || "Miami Architecture"),
      phase: String(flags.phase || "Vertical Slice"),
      game,
      assetStage: String(flags["asset-stage"] || "Designed in Kanban"),
      updatedAt: new Date().toISOString()
    });
    console.log(JSON.stringify({ ok: true, number: created.number, id: created.id, status: created.status, title: created.title }, null, 2));
    return;
  }

  if (cmd === "list-designs") {
    let assets = (await listCollection(cfg, token, "assets")).filter((a) => a.designSpec);
    assets.sort((a, b) => (Number(a.order) ?? 999) - (Number(b.order) ?? 999));
    if (flags.stage) assets = assets.filter((a) => a.stage.toLowerCase() === String(flags.stage).toLowerCase());
    if (flags.phase) assets = assets.filter((a) => (a.designSpec?.phase || "").toLowerCase().includes(String(flags.phase).toLowerCase()));
    console.log(JSON.stringify(assets, null, 2));
    return;
  }

  if (cmd === "get-design") {
    const target = String(pos[0] || "").trim();
    if (!target) throw new Error("Usage: node kanban-ai.mjs get-design <slugOrId>");
    const assets = await listCollection(cfg, token, "assets");
    const found = assets.find((a) => a.id === target || a._docId === target || a.designSpec?.slug === target);
    if (!found) throw new Error(`Asset/design not found: ${target}`);
    console.log(JSON.stringify(found, null, 2));
    return;
  }

  if (cmd === "update-design") {
    const target = String(pos[0] || "").trim();
    if (!target) throw new Error("Usage: node kanban-ai.mjs update-design <slugOrId> [--stage \"Baked & QA Pass\"] [--notes \"...\"] [--priority \"P1 High\"]");
    const assets = await listCollection(cfg, token, "assets");
    const found = assets.find((a) => a.id === target || a._docId === target || a.designSpec?.slug === target);
    if (!found) throw new Error(`Asset/design not found: ${target}`);
    const patch = { updatedAt: new Date().toISOString() };
    if (flags.stage) patch.stage = String(flags.stage);
    if (flags.notes) patch.notes = String(flags.notes);
    if (flags.priority) patch.priority = String(flags.priority);
    if (flags["disk-path"]) patch.diskPath = String(flags["disk-path"]);
    if (flags["target-path"]) patch.targetPath = String(flags["target-path"]);
    const updated = await patchDoc(cfg, token, "assets", found._docId, patch);
    console.log(JSON.stringify({ ok: true, id: updated.id, slug: updated.designSpec?.slug, stage: updated.stage, name: updated.name }, null, 2));
    return;
  }

  if (cmd === "upsert-design") {
    const fileArg = String(flags.file || pos[0] || "").trim();
    if (!fileArg || !fs.existsSync(fileArg)) {
      throw new Error("Usage: node kanban-ai.mjs upsert-design --file <design-entry.json>");
    }
    const entry = JSON.parse(fs.readFileSync(fileArg, "utf8"));
    const docId = String(entry.id || entry.designSpec?.slug || "").trim();
    if (!docId || !entry.name) {
      throw new Error("Design JSON must include at least 'id' (or 'designSpec.slug') and 'name'.");
    }
    const payload = {
      ...entry,
      id: docId,
      stage: entry.stage || "Designed in Kanban",
      game: entry.game || "Sun City RP",
      category: entry.category || "Miami Architecture",
      priority: entry.priority || "P1 High",
      updatedAt: new Date().toISOString()
    };
    delete payload._docId;
    const saved = await patchDoc(cfg, token, "assets", docId, payload);
    console.log(JSON.stringify({ ok: true, id: saved.id, stage: saved.stage, name: saved.name }, null, 2));
    return;
  }

  throw new Error(`Unknown command '${cmd}'. Supported: status, list-cards, get-card, move-card, update-card, create-card, list-designs, get-design, update-design, upsert-design`);
}

main().catch((err) => {
  console.error(`[kanban-ai] ERROR: ${err.message}`);
  process.exit(1);
});
