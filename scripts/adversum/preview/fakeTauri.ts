// Simulated Tauri backend for the browser preview (dev tool, see README.md).
// It implements just enough of the IPC surface for the real frontend to run:
// events, the settings store, the secure store, the HTTP broker (answered by
// fakeKimai.ts) and the fork's own commands.
import { customers, handleKimaiRequest, resetKimai } from "./fakeKimai";

type Args = Record<string, any>;

const params = new URLSearchParams(location.search);
const windowLabel = params.get("window") ?? "tray-popup";
const STORE_KEY = "adversum-preview:store";
const CONNECTION = { id: "preview", name: "Preview", url: "https://kimai.preview.example" };

if (params.get("reset")) {
  localStorage.removeItem(STORE_KEY);
  resetKimai();
}

// ── Persistent store shared by all preview tabs ────────────────
function readStore(): Args {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "") as Args;
  } catch {
    return {};
  }
}

function writeStore(store: Args): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(store));
}

function initialStore(): Args {
  const store = readStore();
  store.settings = {
    connections: [CONNECTION],
    activeConnectionId: CONNECTION.id,
    kimaiUrl: CONNECTION.url,
    language: "de",
    enableNoTimerReminder: true,
    ...store.settings,
    ...(params.get("theme") ? { theme: params.get("theme") } : {}),
    ...(params.get("layout") ? { popupLayout: params.get("layout") } : {}),
  };
  store.adversum = {
    aliases: {
      [CONNECTION.id]: {
        customers: { "1": ["gigi"] },
        projects: {},
        activities: { "1": ["pm"], "2": ["call", "telefonat", "meeting"] },
      },
    },
    ...store.adversum,
    ...(params.get("indicator") ? { customerIndicator: params.get("indicator") } : {}),
  };
  store.favoriteTasks ??= [];
  store.pausedTimers ??= [];
  store.hiddenRecentTasksByConnection ??= {};
  store.manualLogos ??= {};
  writeStore(store);
  return store;
}
initialStore();

// ── Events ─────────────────────────────────────────────────────
let nextId = 1;
const callbacks = new Map<number, (message: unknown) => void>();
const listeners = new Map<string, Map<number, { handler: number; target?: string }>>();
const channel = new BroadcastChannel("adversum-preview");

function dispatch(event: string, payload: unknown, target?: string): void {
  if (target && target !== windowLabel) return;
  for (const [id, listener] of listeners.get(event) ?? []) {
    callbacks.get(listener.handler)?.({ event, id, payload });
  }
}

function emit(event: string, payload: unknown, target?: string): void {
  dispatch(event, payload, target);
  channel.postMessage({ event, payload, target });
}
channel.onmessage = ({ data }) => dispatch(data.event, data.payload, data.target);
window.addEventListener("focus", () => dispatch("tauri://focus", null));
window.addEventListener("blur", () => dispatch("tauri://blur", null));
setInterval(() => dispatch("kimai://tick", null), 1000);

// ── Sample logos ───────────────────────────────────────────────
function sampleLogo(background: string, glyph: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">` +
    `<rect width="128" height="128" fill="${background}"/>` +
    `<text x="64" y="86" font-family="Helvetica,Arial" font-size="64" font-weight="700" fill="#fff" text-anchor="middle">${glyph}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const FETCHED_LOGOS: Record<number, { source: string; dataUrl: string }> = {
  1: { source: "homepage", dataUrl: sampleLogo("#0f766e", "D") },
  2: { source: "logodev", dataUrl: sampleLogo("#111827", "☺") },
  4: { source: "homepage", dataUrl: sampleLogo("#7a19ff", "a") },
};

function logoEntry(customerId: number): Args {
  const homepage = customers.find((customer) => customer.id === customerId)?.homepage.trim() || null;
  const manual = readStore().manualLogos?.[customerId];
  const base = { customerId, stale: false, triedLogoDev: true, homepage, problem: null, detail: null };
  if (manual) return { ...base, source: "manual", dataUrl: manual, expiresAt: null };
  const fetched = FETCHED_LOGOS[customerId];
  const hour = Math.floor(Date.now() / 1000) + 3600;
  if (fetched) return { ...base, source: fetched.source, dataUrl: fetched.dataUrl, expiresAt: hour + 30 * 86400 };
  return {
    ...base,
    source: "none",
    dataUrl: null,
    expiresAt: hour,
    problem: homepage ? "noIcon" : "noHomepage",
  };
}

function setManualLogo(customerId: number, dataUrl: string | null): Args {
  const store = readStore();
  if (dataUrl) store.manualLogos[customerId] = dataUrl;
  else delete store.manualLogos[customerId];
  writeStore(store);
  const entry = logoEntry(customerId);
  emit("adversum://logos-changed", { connectionId: CONNECTION.id, customerId, entry });
  return entry;
}

// ── Commands ───────────────────────────────────────────────────
function matches(item: Args, identity: Args): boolean {
  return Object.entries(identity).every(([key, value]) => item[key] === value);
}

const commands: Record<string, (args: Args) => unknown> = {
  get_platform_info: () => ({
    os: "macos", session: "native", trayBackend: "native",
    supportsTrayClickActions: true, supportsNativePopupCorners: true,
    supportsGlobalShortcuts: true, supportsWindowPositioning: true, supportsAlwaysOnTop: true,
  }),
  "plugin:app|version": () => "0.22.22-preview",
  "plugin:event|listen": ({ event, handler, target }) => {
    const id = nextId++;
    if (!listeners.has(event)) listeners.set(event, new Map());
    listeners.get(event)!.set(id, { handler, target: target?.label });
    return id;
  },
  "plugin:event|unlisten": ({ event, eventId }) => void listeners.get(event)?.delete(eventId),
  "plugin:event|emit": ({ event, payload }) => emit(event, payload),
  "plugin:event|emit_to": ({ target, event, payload }) =>
    emit(event, payload, typeof target === "string" ? target : target?.label),
  "plugin:store|load": () => 1,
  "plugin:store|get_store": () => 1,
  "plugin:store|get": ({ key }) => {
    const store = readStore();
    return [store[key] ?? null, key in store];
  },
  "plugin:window|get_all_windows": () =>
    ["tray-popup", "settings", "timer-reminder", "changelog", "adversum-quick"],
  "plugin:deep-link|get_current": () => null,
  "plugin:log|log": () => null,
  get_api_token: () => "preview-token",
  get_idle_seconds: () => 0,
  get_idle_stats: () => ({ periods: [], retentionDays: 30 }),
  list_monitors: () => [],
  patch_settings: ({ request }) => {
    const store = readStore();
    store.settings = { ...store.settings, ...request.values };
    writeStore(store);
    return { value: store.settings };
  },
  migrate_legacy_store: ({ request }) => {
    const store = readStore();
    switch (request.migration.type) {
      case "pausedTimer": return { value: store.pausedTimers };
      case "hiddenTasks":
        return { value: store.hiddenRecentTasksByConnection[request.migration.connectionId] ?? [] };
      case "settingsConnection": return { value: store.settings };
      default: return { value: null };
    }
  },
  mutate_array_store: ({ request }) => {
    const store = readStore();
    let items: Args[] = store[request.key] ?? [];
    const { mutation } = request;
    if (mutation.type === "appendUnique") {
      items = [...items.filter((item) => !matches(item, mutation.identity)), mutation.value];
      if (mutation.limit) items = items.slice(-mutation.limit);
    } else if (mutation.type === "removeMatching") {
      items = items.filter((item) => !matches(item, mutation.identity));
    } else {
      items = [];
    }
    store[request.key] = items;
    writeStore(store);
    return { value: items };
  },
  mutate_scoped_store: ({ request }) => {
    const store = readStore();
    const scoped: Args = store[request.key] ?? {};
    const { mutation } = request;
    let value = scoped[request.entryKey];
    if (mutation.type === "set") value = mutation.value;
    else if (mutation.type === "addString") value = [...new Set([...(value ?? []), mutation.value])];
    else if (mutation.type === "removeString") value = (value ?? []).filter((item: string) => item !== mutation.value);
    else value = [];
    store[request.key] = { ...scoped, [request.entryKey]: value };
    writeStore(store);
    return { value };
  },
  http_request: ({ request }) => {
    const url = new URL(request.url);
    const reply = handleKimaiRequest(request.method, url, request.body);
    console.debug(`[fake kimai] ${request.method} ${url.pathname}${url.search} → ${reply.status}`);
    return {
      status: reply.status,
      statusText: reply.status < 400 ? "OK" : "Error",
      headers: [["content-type", "application/json"]],
      body: reply.body == null ? "" : JSON.stringify(reply.body),
    };
  },
  adversum_get_settings: () => readStore().adversum ?? {},
  adversum_patch_settings: ({ values }) => {
    const store = readStore();
    store.adversum = { ...store.adversum, ...values };
    writeStore(store);
    emit("adversum://settings-changed", store.adversum);
    return store.adversum;
  },
  adversum_quick_show: () => dispatch("adversum://quick-shown", null),
  adversum_quick_hide: () => console.debug("[fake tauri] quick entry bar hidden"),
  adversum_quick_toast: ({ undoable }) => console.debug(`[fake tauri] toast shown, undoable=${undoable}`),
  adversum_quick_resize: () => null,
  adversum_logo_list: () => customers.map((customer) => logoEntry(customer.id)),
  adversum_logo_fetch: ({ request }) => logoEntry(request.customerId),
  adversum_logo_set_manual: ({ request }) =>
    setManualLogo(request.customerId, `data:image/png;base64,${request.imageBase64}`),
  adversum_logo_clear_manual: ({ request }) => setManualLogo(request.customerId, null),
};

Object.assign(window, {
  __TAURI_INTERNALS__: {
    metadata: {
      currentWindow: { label: windowLabel },
      currentWebview: { label: windowLabel, windowLabel },
    },
    transformCallback(callback: (message: unknown) => void) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback(id: number) {
      callbacks.delete(id);
    },
    async invoke(command: string, args: Args = {}) {
      const handler = commands[command];
      if (!handler) {
        console.debug(`[fake tauri] unhandled ${command}`, args);
        return null;
      }
      return handler(args);
    },
    convertFileSrc: (path: string) => path,
  },
  __TAURI_EVENT_PLUGIN_INTERNALS__: {
    unregisterListener(event: string, eventId: number) {
      listeners.get(event)?.delete(eventId);
    },
  },
  // Lets the preview trigger what a global shortcut or tray click would.
  __previewEmit: emit,
});

document.documentElement.style.background = "#d4d4d8";
if (windowLabel === "adversum-quick") {
  const style = document.createElement("style");
  style.textContent = "#root { width: 680px; margin: 80px auto; }";
  document.head.append(style);
}
if (windowLabel === "tray-popup") {
  // The popup assumes its native window size.
  const style = document.createElement("style");
  style.textContent = "#root { width: 360px; height: 640px; margin: 16px auto; overflow: hidden; border-radius: 12px; box-shadow: 0 10px 40px rgba(0,0,0,.25); } #root > div { width: 100% !important; height: 100% !important; }";
  document.head.append(style);
}
