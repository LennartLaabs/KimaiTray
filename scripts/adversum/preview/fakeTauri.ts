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

// ── Voice input ────────────────────────────────────────────────
// No microphone and no speech model here: "recording" plays a level curve
// and "transcribing" returns a sample sentence (`?say=…` picks your own).
const VOICE_MODELS = [
  { id: "base", sizeBytes: 147_951_465 },
  { id: "small", sizeBytes: 487_601_967 },
  { id: "large-v3-turbo", sizeBytes: 1_624_555_275 },
];
const VOICE_SAMPLES = [
  "DUSW Projektmanagement, Gigi Call seit zehn Uhr.",
  "Ich hab von 10 bis 11 mit Herosmile telefoniert.",
  "Schnaider Design",
  "Notiz: Angebot nachfassen.",
  "Stopp.",
  "Irgendwas mit Zetteln",
];
const VOICE_QUICK = "adversum-quick";
let voiceSample = 0;
let voiceRecording: ReturnType<typeof setInterval> | null = null;
let voiceDownload: { model: string; received: number; total: number; timer: ReturnType<typeof setInterval> } | null = null;

function voiceStore(): Args {
  return { installed: [], permission: "undetermined", ...readStore().voice };
}

function patchVoiceStore(values: Args): void {
  const store = readStore();
  store.voice = { ...voiceStore(), ...values };
  writeStore(store);
}

function voiceState(phase: string, extra: Args = {}): void {
  emit("adversum://voice-state", { phase, manual: true, ...extra }, VOICE_QUICK);
}

function stopVoiceRecording(): boolean {
  if (!voiceRecording) return false;
  clearInterval(voiceRecording);
  voiceRecording = null;
  return true;
}

function startVoiceRecording(): void {
  const voice = voiceStore();
  const settings = readStore().adversum ?? {};
  if (!settings.voiceEnabled) return voiceState("error", { reason: "disabled" });
  if (!voice.installed.includes(settings.voiceModel ?? "small")) {
    return voiceState("error", { reason: "noModel" });
  }
  if (voice.permission !== "granted") {
    patchVoiceStore({ permission: "granted" });
    return voiceState("error", { reason: "permissionRequested" });
  }
  stopVoiceRecording();
  voiceState("recording");
  const sentence = params.get("say") ?? VOICE_SAMPLES[voiceSample % VOICE_SAMPLES.length]!;
  const words = sentence.split(" ");
  let tick = 0;
  voiceRecording = setInterval(() => {
    tick += 1;
    emit("adversum://voice-level", 0.35 + 0.3 * Math.sin(tick / 2) + 0.2 * Math.random(), VOICE_QUICK);
    if (tick % 8 === 0) {
      emit("adversum://voice-partial", words.slice(0, tick / 8).join(" "), VOICE_QUICK);
    }
  }, 60);
}

function finishVoiceRecording(): void {
  if (!stopVoiceRecording()) return;
  voiceState("transcribing");
  const text = params.get("say") ?? VOICE_SAMPLES[voiceSample++ % VOICE_SAMPLES.length]!;
  setTimeout(() => voiceState("result", { text }), 700);
}

function startVoiceDownload(model: string): void {
  const total = VOICE_MODELS.find((item) => item.id === model)?.sizeBytes ?? 0;
  if (voiceDownload || total === 0) return;
  const announce = (state: string, received: number) =>
    emit("adversum://voice-download", { model, state, received, total });
  const timer = setInterval(() => {
    const download = voiceDownload!;
    download.received = Math.min(total, download.received + total / 40);
    if (download.received < total) return announce("progress", download.received);
    clearInterval(timer);
    voiceDownload = null;
    patchVoiceStore({ installed: [...new Set([...voiceStore().installed, model])] });
    announce("done", total);
  }, 100);
  voiceDownload = { model, received: 0, total, timer };
  announce("progress", 0);
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
  adversum_voice_status: () => {
    const voice = voiceStore();
    const custom = readStore().adversum?.voiceModelDir;
    const defaultModelDir = "/Users/preview/Library/Application Support/io.adversum.kimaitray/adversum/models";
    return {
      supported: true,
      permission: voice.permission,
      liveText: true,
      models: VOICE_MODELS.map((model) => ({ ...model, installed: voice.installed.includes(model.id) })),
      modelDir: custom || defaultModelDir,
      defaultModelDir,
      download: voiceDownload
        ? { model: voiceDownload.model, state: "progress", received: voiceDownload.received, total: voiceDownload.total }
        : null,
      debugDir: "/Users/preview/Library/Application Support/io.adversum.kimaitray/adversum/voice-debug",
    };
  },
  // Several entries from one sentence: no language model in the browser,
  // so the rules alone decide, as on a Mac without Apple Intelligence.
  adversum_multi_status: () => ({
    mode: readStore().adversum?.multiModel ?? "auto",
    apple: "missing",
    claude: false,
  }),
  adversum_multi_extract: () => null,
  adversum_voice_devices: () => [
    { id: "coreaudio:usb", name: "Trust USB microphone", isDefault: true },
    { id: "coreaudio:teams", name: "Microsoft Teams Audio", isDefault: false },
  ],
  adversum_voice_test_start: () => {
    let tick = 0;
    stopVoiceRecording();
    voiceRecording = setInterval(() => {
      tick += 1;
      emit("adversum://voice-level", 0.4 + 0.3 * Math.sin(tick / 2), "settings");
    }, 60);
  },
  adversum_voice_test_finish: () => {
    stopVoiceRecording();
    return {
      outcome: "ok",
      text: "DUSW Projektmanagement, Gigi Call seit 10 Uhr.",
      detail: null,
      info: { device: "Trust USB microphone", sampleRate: 48000, channels: 2, sampleFormat: "f32" },
      report: {
        seconds: 3.4, channelRms: [0.0312, 0.0298], channelPeak: [0.41, 0.4], usedChannel: 0,
        offset: 0.0012, noiseFloor: 0.0004, speechLevel: 0.052, hasSpeech: true, gain: 1.2,
        rms: 0.04, peak: 0.5,
      },
      rawPath: "/Users/preview/Library/Application Support/io.adversum.kimaitray/adversum/voice-debug/last-raw.wav",
      preparedPath: "/Users/preview/Library/Application Support/io.adversum.kimaitray/adversum/voice-debug/last-16k.wav",
    };
  },
  adversum_voice_download: ({ model }) => startVoiceDownload(model),
  adversum_voice_cancel_download: () => {
    if (!voiceDownload) return;
    clearInterval(voiceDownload.timer);
    const { model, total } = voiceDownload;
    voiceDownload = null;
    emit("adversum://voice-download", { model, state: "cancelled", received: 0, total });
  },
  adversum_voice_delete_model: ({ model }) =>
    patchVoiceStore({ installed: voiceStore().installed.filter((id: string) => id !== model) }),
  adversum_voice_choose_dir: () => "/Volumes/Extern/Sprachmodelle",
  adversum_voice_request_permission: () => {
    patchVoiceStore({ permission: "granted" });
    emit("adversum://voice-permission", true);
    return "granted";
  },
  adversum_voice_open_privacy: () => console.debug("[fake tauri] privacy settings opened"),
  adversum_voice_start: () => startVoiceRecording(),
  adversum_voice_finish: () => finishVoiceRecording(),
  adversum_voice_cancel: () => void stopVoiceRecording(),
  adversum_voice_set_vocabulary: ({ vocabulary }) =>
    console.debug(`[fake tauri] speech vocabulary: ${vocabulary}`),
  adversum_learn_alias: ({ connectionId, kind, entityId, alias }) => {
    const store = readStore();
    const aliases = store.adversum.aliases ?? {};
    const connection = aliases[connectionId] ?? { customers: {}, projects: {}, activities: {} };
    const list: string[] = connection[kind][String(entityId)] ?? [];
    if (list.includes(alias)) return false;
    connection[kind][String(entityId)] = [...list, alias];
    store.adversum = { ...store.adversum, aliases: { ...aliases, [connectionId]: connection } };
    writeStore(store);
    emit("adversum://settings-changed", store.adversum);
    return true;
  },
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
