// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAdversumSettings } from "./adversumSettings";

const mocks = vi.hoisted(() => ({
  supportsGlobalShortcuts: true,
  settings: { settings: {} as any, update: vi.fn() },
  listen: vi.fn(),
  getVoiceStatus: vi.fn(),
  getVoiceDevices: vi.fn(),
  downloadVoiceModel: vi.fn(),
  cancelVoiceDownload: vi.fn(),
  deleteVoiceModel: vi.fn(),
  chooseVoiceModelDir: vi.fn(),
  requestVoicePermission: vi.fn(),
  openVoicePrivacySettings: vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      options ? `${key}:${Object.values(options).join(",")}` : key,
  }),
}));
vi.mock("../../platform", () => ({
  usePlatform: () => ({ os: "macos", supportsGlobalShortcuts: mocks.supportsGlobalShortcuts }),
}));
vi.mock("./useAdversumSettings", () => ({ useAdversumSettings: () => mocks.settings }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("./AcceleratorInput", () => ({
  default: (props: { value: string; disabled?: boolean; onChange: (value: string) => void }) => (
    <button type="button" data-testid="voice-key" disabled={props.disabled} onClick={() => props.onChange("Alt+F5")}>
      {props.value}
    </button>
  ),
}));
vi.mock("./MicrophoneTest", () => ({ default: () => <div>microphone-test</div> }));
vi.mock("../voice/voiceApi", async (original) => ({
  ...(await original<typeof import("../voice/voiceApi")>()),
  getVoiceStatus: mocks.getVoiceStatus,
  getVoiceDevices: mocks.getVoiceDevices,
  downloadVoiceModel: mocks.downloadVoiceModel,
  cancelVoiceDownload: mocks.cancelVoiceDownload,
  deleteVoiceModel: mocks.deleteVoiceModel,
  chooseVoiceModelDir: mocks.chooseVoiceModelDir,
  requestVoicePermission: mocks.requestVoicePermission,
  openVoicePrivacySettings: mocks.openVoicePrivacySettings,
}));

import { VOICE_DOWNLOAD_EVENT, VOICE_PERMISSION_EVENT, type VoiceStatus } from "../voice/voiceApi";
import VoiceSection, { formatSize } from "./VoiceSection";

const baseStatus: VoiceStatus = {
  supported: true,
  permission: "granted",
  liveText: true,
  models: [
    { id: "base", sizeBytes: 147_951_465, installed: false },
    { id: "small", sizeBytes: 487_601_967, installed: false },
    { id: "large-v3-turbo", sizeBytes: 1_624_555_275, installed: false },
  ],
  modelDir: "/Users/l/Library/Application Support/io.adversum.kimaitray/adversum/models",
  defaultModelDir: "/Users/l/Library/Application Support/io.adversum.kimaitray/adversum/models",
  download: null,
  debugDir: "/Users/l/Library/Application Support/io.adversum.kimaitray/adversum/voice-debug",
};

let status: VoiceStatus;
let handlers: Record<string, (event: { payload: unknown }) => void>;

function installed(...ids: string[]): VoiceStatus["models"] {
  return baseStatus.models.map((model) => ({ ...model, installed: ids.includes(model.id) }));
}

function useSettings(values: Record<string, unknown> = {}) {
  mocks.settings = {
    settings: { ...defaultAdversumSettings, ...values },
    update: mocks.settings.update,
  };
}

async function renderPage() {
  const view = render(<VoiceSection />);
  await waitFor(() => expect(mocks.getVoiceStatus).toHaveBeenCalled());
  await act(async () => undefined);
  return view;
}

function row(model: string): HTMLElement {
  return document.querySelector(`[data-voice-model='${model}']`) as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers = {};
  status = { ...baseStatus };
  mocks.supportsGlobalShortcuts = true;
  mocks.settings.update = vi.fn().mockResolvedValue(true);
  useSettings();
  mocks.getVoiceStatus.mockImplementation(async () => status);
  mocks.getVoiceDevices.mockResolvedValue([
    { id: "coreaudio:usb", name: "Trust USB microphone", isDefault: true },
    { id: "coreaudio:teams", name: "Microsoft Teams Audio", isDefault: false },
  ]);
  mocks.listen.mockImplementation(async (event: string, handler: (event: { payload: unknown }) => void) => {
    handlers[event] = handler;
    return vi.fn();
  });
  for (const mock of [
    mocks.downloadVoiceModel, mocks.cancelVoiceDownload, mocks.deleteVoiceModel,
    mocks.openVoicePrivacySettings,
  ]) {
    mock.mockResolvedValue(undefined);
  }
  mocks.requestVoicePermission.mockResolvedValue("undetermined");
  mocks.chooseVoiceModelDir.mockResolvedValue(null);
});
afterEach(cleanup);

describe("formatSize", () => {
  it("uses decimal megabytes and gigabytes", () => {
    expect(formatSize(147_951_465)).toBe("148 MB");
    expect(formatSize(487_601_967)).toBe("488 MB");
    expect(formatSize(1_624_555_275)).toBe(`${(1.6).toLocaleString()} GB`);
    expect(formatSize(0)).toBe("0 MB");
  });
});

describe("VoiceSection", () => {
  it("says where voice input does not exist, and shows nothing without a status", async () => {
    status = { ...baseStatus, supported: false };
    const unsupported = await renderPage();
    expect(screen.getByText("adversum.voice.settings.unsupported")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    unsupported.unmount();

    mocks.getVoiceStatus.mockRejectedValue(new Error("no command"));
    await renderPage();
    expect(screen.getByText("adversum.voice.title")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("lists the models with their size and what is stored", async () => {
    status = { ...baseStatus, models: installed("base", "small") };
    await renderPage();
    expect(within(row("base")).getByRole("radio").textContent).toContain("148 MB");
    expect(within(row("small")).getByRole("radio").getAttribute("aria-checked")).toBe("true");
    expect(within(row("base")).getByRole("radio").getAttribute("aria-checked")).toBe("false");
    expect(within(row("small")).getByText("adversum.voice.settings.installed")).toBeTruthy();
    expect(within(row("large-v3-turbo")).getByText("adversum.voice.settings.download")).toBeTruthy();
    expect(document.querySelector("[data-voice-folder]")?.textContent).toBe(status.modelDir);
    expect(screen.getByText(/adversum\.voice\.settings\.used:636 MB/)).toBeTruthy();
    expect(screen.queryByText("shortcuts.waylandUnavailable")).toBeNull();
    expect(screen.getByText("adversum.voice.settings.privacy")).toBeTruthy();
  });

  it("downloads the model and asks for the microphone when first switched on", async () => {
    status = { ...baseStatus, permission: "undetermined" };
    await renderPage();
    fireEvent.click(screen.getByRole("switch", { name: "adversum.voice.settings.enable" }));
    await waitFor(() => expect(mocks.downloadVoiceModel).toHaveBeenCalledWith("small"));
    expect(mocks.settings.update).toHaveBeenCalledWith("voiceEnabled", true);
    expect(mocks.requestVoicePermission).toHaveBeenCalledTimes(1);

    // Progress arrives as events.
    expect(within(row("small")).getByRole("status").textContent).toBe(
      "adversum.voice.settings.downloading:0",
    );
    act(() =>
      handlers[VOICE_DOWNLOAD_EVENT]!({
        payload: { model: "small", state: "progress", received: 243_800_984, total: 487_601_967 },
      }),
    );
    expect(within(row("small")).getByRole("status").textContent).toBe(
      "adversum.voice.settings.downloading:50",
    );
    expect((row("small").querySelector("[data-voice-progress]") as HTMLElement).style.width).toBe("50%");
    // Only one download at a time.
    expect(within(row("base")).getByRole("button", { name: /downloadLabel/ })).toHaveProperty("disabled", true);

    fireEvent.click(within(row("small")).getByRole("button", { name: "adversum.voice.settings.cancel" }));
    expect(mocks.cancelVoiceDownload).toHaveBeenCalledTimes(1);

    status = { ...baseStatus, models: installed("small") };
    await act(async () =>
      handlers[VOICE_DOWNLOAD_EVENT]!({
        payload: { model: "small", state: "done", received: 487_601_967, total: 487_601_967 },
      }),
    );
    await waitFor(() =>
      expect(within(row("small")).getByText("adversum.voice.settings.installed")).toBeTruthy(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("needs nothing more when model and permission are there, or when switched off", async () => {
    status = { ...baseStatus, models: installed("small") };
    await renderPage();
    fireEvent.click(screen.getByRole("switch", { name: "adversum.voice.settings.enable" }));
    await waitFor(() => expect(mocks.settings.update).toHaveBeenCalledWith("voiceEnabled", true));
    await act(async () => undefined);
    expect(mocks.downloadVoiceModel).not.toHaveBeenCalled();
    expect(mocks.requestVoicePermission).not.toHaveBeenCalled();
    cleanup();

    status = { ...baseStatus };
    useSettings({ voiceEnabled: true });
    await renderPage();
    fireEvent.click(screen.getByRole("switch", { name: "adversum.voice.settings.enable" }));
    await waitFor(() => expect(mocks.settings.update).toHaveBeenCalledWith("voiceEnabled", false));
    await act(async () => undefined);
    expect(mocks.downloadVoiceModel).not.toHaveBeenCalled();
    cleanup();

    // Saving the switch failed: nothing follows.
    mocks.settings.update.mockResolvedValue(false);
    useSettings();
    await renderPage();
    fireEvent.click(screen.getByRole("switch", { name: "adversum.voice.settings.enable" }));
    await act(async () => undefined);
    expect(mocks.downloadVoiceModel).not.toHaveBeenCalled();
  });

  it("continues a download that was running when the page opened", async () => {
    status = {
      ...baseStatus,
      permission: "undetermined",
      download: { model: "base", state: "progress", received: 10, total: 0 },
    };
    await renderPage();
    expect(within(row("base")).getByRole("status").textContent).toBe(
      "adversum.voice.settings.downloading:0",
    );
    // Switching on meanwhile does not start a second one.
    mocks.requestVoicePermission.mockRejectedValue(new Error("no AVFoundation"));
    fireEvent.click(screen.getByRole("switch", { name: "adversum.voice.settings.enable" }));
    await act(async () => undefined);
    expect(mocks.downloadVoiceModel).not.toHaveBeenCalled();
  });

  it("reports a failed download", async () => {
    mocks.downloadVoiceModel.mockRejectedValue(new Error("offline"));
    await renderPage();
    fireEvent.click(within(row("base")).getByRole("button", { name: /downloadLabel/ }));
    expect(mocks.downloadVoiceModel).toHaveBeenCalledWith("base");
    await act(async () =>
      handlers[VOICE_DOWNLOAD_EVENT]!({
        payload: { model: "base", state: "failed", received: 0, total: 147_951_465 },
      }),
    );
    expect(screen.getByRole("alert").textContent).toBe("adversum.voice.settings.downloadFailed");
    expect(within(row("base")).queryByRole("status")).toBeNull();
    // A new attempt clears the message.
    fireEvent.click(within(row("base")).getByRole("button", { name: /downloadLabel/ }));
    expect(screen.queryByRole("alert")).toBeNull();

    await act(async () =>
      handlers[VOICE_DOWNLOAD_EVENT]!({
        payload: { model: "base", state: "cancelled", received: 0, total: 147_951_465 },
      }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("selects a model and loads it when voice input is on", async () => {
    await renderPage();
    fireEvent.click(within(row("base")).getByRole("radio"));
    expect(mocks.settings.update).toHaveBeenCalledWith("voiceModel", "base");
    expect(mocks.downloadVoiceModel).not.toHaveBeenCalled();
    cleanup();

    status = { ...baseStatus, models: installed("small") };
    useSettings({ voiceEnabled: true });
    await renderPage();
    fireEvent.click(within(row("small")).getByRole("radio"));
    expect(mocks.downloadVoiceModel).not.toHaveBeenCalled();
    fireEvent.click(within(row("large-v3-turbo")).getByRole("radio"));
    expect(mocks.downloadVoiceModel).toHaveBeenCalledWith("large-v3-turbo");
    fireEvent.click(within(row("base")).getByRole("radio"));
    expect(mocks.downloadVoiceModel).toHaveBeenCalledTimes(1);
  });

  it("deletes a downloaded model", async () => {
    status = { ...baseStatus, models: installed("base") };
    mocks.deleteVoiceModel.mockImplementation(async () => {
      status = { ...baseStatus };
    });
    await renderPage();
    fireEvent.click(within(row("base")).getByRole("button", { name: /deleteLabel/ }));
    await waitFor(() =>
      expect(within(row("base")).getByText("adversum.voice.settings.download")).toBeTruthy(),
    );
    expect(mocks.deleteVoiceModel).toHaveBeenCalledWith("base");

    mocks.deleteVoiceModel.mockRejectedValue(new Error("busy"));
    status = { ...baseStatus, models: installed("small") };
    await act(async () => handlers[VOICE_PERMISSION_EVENT]!({ payload: true }));
    await waitFor(() => expect(within(row("small")).getByRole("button", { name: /deleteLabel/ })).toBeTruthy());
    fireEvent.click(within(row("small")).getByRole("button", { name: /deleteLabel/ }));
    await act(async () => undefined);
    expect(within(row("small")).getByText("adversum.voice.settings.installed")).toBeTruthy();
  });

  it("shows the microphone permission and the way to change it", async () => {
    status = { ...baseStatus, permission: "undetermined" };
    await renderPage();
    expect(document.querySelector("[data-voice-permission='undetermined']")).not.toBeNull();
    status = { ...baseStatus, permission: "denied" };
    fireEvent.click(screen.getByRole("button", { name: "adversum.voice.settings.requestPermission" }));
    await waitFor(() =>
      expect(document.querySelector("[data-voice-permission='denied']")).not.toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "adversum.voice.openPrivacy" }));
    expect(mocks.openVoicePrivacySettings).toHaveBeenCalledTimes(1);

    // Back from the system settings, the page reads the permission again.
    status = { ...baseStatus, permission: "granted" };
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() =>
      expect(document.querySelector("[data-voice-permission='granted']")).not.toBeNull(),
    );
    expect(screen.queryByRole("button", { name: "adversum.voice.openPrivacy" })).toBeNull();
  });

  it("changes and resets the model folder", async () => {
    mocks.chooseVoiceModelDir.mockResolvedValueOnce(null).mockResolvedValueOnce("/Volumes/Extern/Modelle");
    await renderPage();
    expect(screen.queryByRole("button", { name: "adversum.voice.settings.resetFolder" })).toBeNull();
    const choose = screen.getByRole("button", { name: "adversum.voice.settings.chooseFolder" });
    fireEvent.click(choose);
    await act(async () => undefined);
    expect(mocks.settings.update).not.toHaveBeenCalled();
    fireEvent.click(choose);
    await waitFor(() =>
      expect(mocks.settings.update).toHaveBeenCalledWith("voiceModelDir", "/Volumes/Extern/Modelle"),
    );
    expect(screen.queryByRole("alert")).toBeNull();

    // A folder the native side refuses, and a dialog that fails.
    mocks.settings.update.mockResolvedValueOnce(false);
    mocks.chooseVoiceModelDir.mockResolvedValueOnce("/nope").mockRejectedValueOnce(new Error("no dialog"));
    fireEvent.click(choose);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("adversum.voice.settings.folderRejected"),
    );
    fireEvent.click(choose);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    cleanup();

    useSettings({ voiceModelDir: "/Volumes/Extern/Modelle" });
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "adversum.voice.settings.resetFolder" }));
    expect(mocks.settings.update).toHaveBeenCalledWith("voiceModelDir", "");
  });

  it("chooses the microphone and offers the test and the diagnosis switch", async () => {
    await renderPage();
    const select = screen.getByRole("combobox", { name: "adversum.voice.settings.device" }) as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "adversum.voice.settings.systemInput",
      "adversum.voice.settings.deviceIsSystemInput:Trust USB microphone",
      "Microsoft Teams Audio",
    ]);
    expect(select.value).toBe("");
    fireEvent.change(select, { target: { value: "coreaudio:teams" } });
    expect(mocks.settings.update).toHaveBeenCalledWith("voiceInputDevice", "coreaudio:teams");
    expect(screen.getByText("microphone-test")).toBeTruthy();
    expect(document.querySelector("[data-voice-debug-dir]")?.textContent).toBe(status.debugDir);
    fireEvent.click(screen.getByRole("switch", { name: "adversum.voice.settings.debug" }));
    expect(mocks.settings.update).toHaveBeenCalledWith("voiceDebug", true);
    cleanup();

    // A stored microphone that is connected is simply selected.
    useSettings({ voiceInputDevice: "coreaudio:teams" });
    await renderPage();
    const chosen = screen.getByRole("combobox", { name: "adversum.voice.settings.device" }) as HTMLSelectElement;
    expect(chosen.value).toBe("coreaudio:teams");
    expect(chosen.options).toHaveLength(3);
    cleanup();

    // A stored microphone that is unplugged stays selectable, and a failing
    // device list leaves the system input.
    mocks.getVoiceDevices.mockRejectedValue(new Error("no CoreAudio"));
    useSettings({ voiceInputDevice: "coreaudio:gone" });
    await renderPage();
    const again = screen.getByRole("combobox", { name: "adversum.voice.settings.device" }) as HTMLSelectElement;
    expect([...again.options].map((option) => option.textContent)).toEqual([
      "adversum.voice.settings.systemInput",
      "adversum.voice.settings.deviceMissing",
    ]);
    expect(again.value).toBe("coreaudio:gone");
  });

  it("sets the voice key and how it is used", async () => {
    await renderPage();
    expect(screen.getByText("adversum.voice.settings.shortcutDescription")).toBeTruthy();
    expect(screen.getByTestId("voice-key").textContent).toBe("Control+Alt+V");
    fireEvent.click(screen.getByTestId("voice-key"));
    await waitFor(() => expect(mocks.settings.update).toHaveBeenCalledWith("shortcutVoice", "Alt+F5"));
    expect(screen.queryByRole("alert")).toBeNull();

    mocks.settings.update.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByTestId("voice-key"));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("adversum.quickSettings.shortcutRejected"),
    );

    fireEvent.click(screen.getByRole("switch", { name: "adversum.voice.settings.tapMode" }));
    expect(mocks.settings.update).toHaveBeenCalledWith("voiceTapMode", true);
    cleanup();

    mocks.supportsGlobalShortcuts = false;
    useSettings({ voiceTapMode: true });
    await renderPage();
    expect(screen.getByText("adversum.voice.settings.shortcutTapDescription")).toBeTruthy();
    expect(screen.getByText("shortcuts.waylandUnavailable")).toBeTruthy();
    expect(screen.getByTestId("voice-key")).toHaveProperty("disabled", true);
  });

  it("survives a window without events and failing native calls", async () => {
    mocks.listen.mockRejectedValue(new Error("no events"));
    mocks.cancelVoiceDownload.mockRejectedValue(new Error("gone"));
    mocks.openVoicePrivacySettings.mockRejectedValue(new Error("gone"));
    mocks.requestVoicePermission.mockRejectedValue(new Error("gone"));
    status = {
      ...baseStatus,
      permission: "undetermined",
      download: { model: "base", state: "progress", received: 1, total: 4 },
    };
    const { unmount } = await renderPage();
    fireEvent.click(within(row("base")).getByRole("button", { name: "adversum.voice.settings.cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "adversum.voice.settings.requestPermission" }));
    await act(async () => undefined);
    cleanup();

    status = { ...baseStatus, permission: "denied" };
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "adversum.voice.openPrivacy" }));
    await act(async () => undefined);
    expect(() => unmount()).not.toThrow();
  });
});
