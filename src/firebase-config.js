export const OWNER_EMAIL = "c0deconnoiseur@gmail.com";
export const WORKSPACE_ID = "velumix";
export const LOCAL_FIREBASE_STORAGE_KEY = "velumix_kanban_firebase_config_v1";

// Populated via GitHub Actions repo variable VITE_FIREBASE_CONFIG or Firebase Web SDK setup
const BUILD_TIME_CONFIG = (() => {
  const raw = import.meta.env.VITE_FIREBASE_CONFIG;
  if (!raw) return null;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
})();

export const DEFAULT_FIREBASE_CONFIG = BUILD_TIME_CONFIG || {
  apiKey: "AIzaSyAjML6dmdUMlPy0Ubo2yp2LnVIcgCdNppY",
  authDomain: "velumix-suncity-kanban.firebaseapp.com",
  projectId: "velumix-suncity-kanban",
  storageBucket: "velumix-suncity-kanban.firebasestorage.app",
  messagingSenderId: "422359582778",
  appId: "1:422359582778:web:5f278313e3fa8cd59b4d03"
};

export function loadFirebaseConfig() {
  if (DEFAULT_FIREBASE_CONFIG && DEFAULT_FIREBASE_CONFIG.apiKey && DEFAULT_FIREBASE_CONFIG.projectId) {
    return DEFAULT_FIREBASE_CONFIG;
  }
  try {
    const saved = localStorage.getItem(LOCAL_FIREBASE_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && parsed.apiKey && parsed.projectId) return parsed;
    }
  } catch {
    // ignore storage errors
  }
  return null;
}

export function saveLocalFirebaseConfig(rawInput) {
  const text = String(rawInput || "").trim();
  if (!text) throw new Error("Paste your Firebase Web config object or JSON.");

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    const objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch) {
      const jsonNormalized = objMatch[0]
        .replace(/\/\/.*$/gm, "")
        .replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":')
        .replace(/'/g, '"')
        .replace(/,\s*}/g, "}");
      parsed = JSON.parse(jsonNormalized);
    }
  }

  if (!parsed || !parsed.apiKey || !parsed.projectId) {
    throw new Error("Config must include at least apiKey, authDomain, and projectId.");
  }
  if (!parsed.authDomain) {
    parsed.authDomain = `${parsed.projectId}.firebaseapp.com`;
  }
  localStorage.setItem(LOCAL_FIREBASE_STORAGE_KEY, JSON.stringify(parsed));
  return parsed;
}
