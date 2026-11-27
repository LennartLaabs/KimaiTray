import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import {
  ADVERSUM_SETTINGS_EVENT,
  defaultAdversumSettings,
  emptyConnectionAliases,
  loadAdversumSettings,
  normalizeAdversumSettings,
  onAdversumSettingsChange,
  patchAdversumSettings,
} from "./adversumSettings";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("normalizeAdversumSettings", () => {
  it("returns the defaults for anything that is not a settings object", () => {
    for (const raw of [null, undefined, "x", 3, []]) {
      expect(normalizeAdversumSettings(raw)).toEqual(defaultAdversumSettings);
    }
    expect(defaultAdversumSettings.customerIndicator).toBe("logo");
    expect(defaultAdversumSettings.shortcutQuickEntry).toBe("Control+Alt+Space");
    expect(defaultAdversumSettings.shortcutPreviousTask).toBe("Control+Alt+Z");
  });

  it("keeps valid values and replaces invalid ones", () => {
    expect(
      normalizeAdversumSettings({
        customerIndicator: "dots",
        logoDevToken: "  pk_abc  ",
        shortcutQuickEntry: "",
        shortcutPreviousTask: "Alt+B",
        voiceEnabled: true,
        voiceModel: "large-v3-turbo",
        voiceModelDir: "/Volumes/Extern/Modelle",
        voiceTapMode: true,
        shortcutVoice: "Alt+F5",
        voiceInputDevice: "coreaudio:usb",
        voiceDebug: true,
        multiModel: "auto",
        teamMembers: [" Patrick ", "", 7, "x".repeat(41), "Ema"],
        brainModel: "qwen-1b5",
        brainModelDir: "/Volumes/Extern/KI",
      }),
    ).toEqual({
      customerIndicator: "dots",
      logoDevToken: "pk_abc",
      shortcutQuickEntry: "",
      shortcutPreviousTask: "Alt+B",
      aliases: {},
      voiceEnabled: true,
      voiceModel: "large-v3-turbo",
      voiceModelDir: "/Volumes/Extern/Modelle",
      voiceTapMode: true,
      shortcutVoice: "Alt+F5",
      voiceInputDevice: "coreaudio:usb",
      voiceDebug: true,
      multiModel: "auto",
      teamMembers: ["Patrick", "Ema"],
      brainModel: "qwen-1b5",
      brainModelDir: "/Volumes/Extern/KI",
    });
    expect(
      normalizeAdversumSettings({
        customerIndicator: "rainbow",
        logoDevToken: "x".repeat(129),
        shortcutQuickEntry: 5,
        shortcutPreviousTask: "y".repeat(257),
        voiceEnabled: "yes",
        voiceModel: "tiny",
        voiceModelDir: 7,
        voiceTapMode: 1,
        shortcutVoice: null,
        voiceInputDevice: "x".repeat(513),
        voiceDebug: 1,
        multiModel: "cloud",
        teamMembers: "Patrick",
        brainModel: "gpt",
        brainModelDir: 7,
      }),
    ).toEqual(defaultAdversumSettings);
    expect(defaultAdversumSettings).toMatchObject({
      voiceEnabled: false,
      voiceModel: "small",
      voiceModelDir: "",
      voiceTapMode: false,
      shortcutVoice: "Control+Alt+V",
    });
  });

  it("cleans alias lists per connection and entity", () => {
    const many = Array.from({ length: 30 }, (_, index) => `alias${index}`);
    const settings = normalizeAdversumSettings({
      aliases: {
        "conn-1": {
          customers: { "7": [" gigi ", "Gigi", "", 4, "dusw"], "0": ["zero"], abc: ["x"] },
          projects: { "12": many, "13": "pm", "14": [] },
          activities: "nope",
        },
        "": { customers: { "1": ["a"] } },
        "conn-2": "nope",
        ["c".repeat(257)]: {},
      },
    });
    expect(Object.keys(settings.aliases)).toEqual(["conn-1"]);
    expect(settings.aliases["conn-1"]).toEqual({
      customers: { "7": ["gigi", "dusw"] },
      projects: { "12": many.slice(0, 20) },
      activities: {},
    });
    expect(normalizeAdversumSettings({ aliases: [] }).aliases).toEqual({});
    expect(emptyConnectionAliases()).toEqual({ customers: {}, projects: {}, activities: {} });
  });

  it("truncates overlong aliases", () => {
    const settings = normalizeAdversumSettings({
      aliases: { c: { customers: { "1": ["a".repeat(100)] } } },
    });
    expect(settings.aliases.c?.customers["1"]).toEqual(["a".repeat(64)]);
  });
});

describe("adversum settings store", () => {
  it("loads through the native command and falls back to defaults", async () => {
    mocks.invoke.mockResolvedValueOnce({ customerIndicator: "dots" });
    await expect(loadAdversumSettings()).resolves.toMatchObject({ customerIndicator: "dots" });
    expect(mocks.invoke).toHaveBeenCalledWith("adversum_get_settings");

    mocks.invoke.mockRejectedValueOnce(new Error("no store"));
    await expect(loadAdversumSettings()).resolves.toEqual(defaultAdversumSettings);
  });

  it("patches single keys and returns the normalized result", async () => {
    mocks.invoke.mockResolvedValueOnce({ logoDevToken: "pk_new", customerIndicator: "x" });
    await expect(patchAdversumSettings({ logoDevToken: "pk_new" })).resolves.toMatchObject({
      logoDevToken: "pk_new",
      customerIndicator: "logo",
    });
    expect(mocks.invoke).toHaveBeenCalledWith("adversum_patch_settings", {
      values: { logoDevToken: "pk_new" },
    });
  });

  it("delivers normalized settings from other windows", async () => {
    const unlisten = vi.fn();
    mocks.listen.mockResolvedValue(unlisten);
    const callback = vi.fn();
    await expect(onAdversumSettingsChange(callback)).resolves.toBe(unlisten);
    const [event, handler] = mocks.listen.mock.calls[0]!;
    expect(event).toBe(ADVERSUM_SETTINGS_EVENT);
    handler({ payload: { customerIndicator: "dots", extra: true } });
    expect(callback).toHaveBeenCalledWith({
      ...defaultAdversumSettings,
      customerIndicator: "dots",
    });
  });
});
