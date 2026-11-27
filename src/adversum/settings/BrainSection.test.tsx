// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAdversumSettings } from "./adversumSettings";

const mocks = vi.hoisted(() => ({
  settings: { settings: {} as any, update: vi.fn() },
  listen: vi.fn(),
  getBrainStatus: vi.fn(),
  getMultiModelStatus: vi.fn(),
  downloadBrainModel: vi.fn(),
  deleteBrainModel: vi.fn(),
  cancelVoiceDownload: vi.fn(),
  chooseVoiceModelDir: vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      options ? `${key}:${Object.values(options).join(",")}` : key,
  }),
}));
vi.mock("./useAdversumSettings", () => ({ useAdversumSettings: () => mocks.settings }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("../multi/modelApi", () => ({
  getBrainStatus: mocks.getBrainStatus,
  getMultiModelStatus: mocks.getMultiModelStatus,
  downloadBrainModel: mocks.downloadBrainModel,
  deleteBrainModel: mocks.deleteBrainModel,
}));
vi.mock("../voice/voiceApi", async (original) => ({
  ...(await original<typeof import("../voice/voiceApi")>()),
  cancelVoiceDownload: mocks.cancelVoiceDownload,
  chooseVoiceModelDir: mocks.chooseVoiceModelDir,
}));

import type { BrainStatus } from "../multi/modelApi";
import { VOICE_DOWNLOAD_EVENT } from "../voice/voiceApi";
import BrainSection from "./BrainSection";

const baseStatus: BrainStatus = {
  helper: true,
  models: [
    { id: "gemma-3-4b", sizeBytes: 2_489_758_112, installed: false },
    { id: "qwen-1b5", sizeBytes: 1_117_320_736, installed: false },
  ],
  activeModel: null,
  modelDir: "/Users/l/Library/Application Support/io.adversum.kimaitray/adversum/models",
  defaultModelDir: "/Users/l/Library/Application Support/io.adversum.kimaitray/adversum/models",
  modelVolume: null,
  download: null,
};
let status: BrainStatus;
let handlers: Record<string, (event: { payload: unknown }) => void>;

function useSettings(values: Record<string, unknown> = {}) {
  mocks.settings = {
    settings: { ...defaultAdversumSettings, ...values },
    update: mocks.settings.update,
  };
}

async function renderSection() {
  const view = render(<BrainSection />);
  await waitFor(() => expect(mocks.getBrainStatus).toHaveBeenCalled());
  await act(async () => undefined);
  return view;
}

function row(model: string): HTMLElement {
  return document.querySelector(`[data-brain-model='${model}']`) as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers = {};
  status = { ...baseStatus };
  mocks.settings.update = vi.fn().mockResolvedValue(true);
  useSettings();
  mocks.listen.mockImplementation(async (event: string, handler: (event: { payload: unknown }) => void) => {
    handlers[event] = handler;
    return vi.fn();
  });
  mocks.getBrainStatus.mockImplementation(async () => status);
  mocks.getMultiModelStatus.mockResolvedValue({ mode: "device", local: false, claude: true });
  for (const mock of [mocks.downloadBrainModel, mocks.deleteBrainModel, mocks.cancelVoiceDownload]) {
    mock.mockResolvedValue(undefined);
  }
  mocks.chooseVoiceModelDir.mockResolvedValue(null);
});
afterEach(cleanup);

describe("the settings for the local language model", () => {
  it("lists the models with size and license and says who may help", async () => {
    await renderSection();
    expect(screen.getByText("adversum.brain.title")).toBeTruthy();
    expect(row("gemma-3-4b").textContent).toContain("adversum.brain.models.gemma-3-4b.name · 2.5 GB");
    expect(row("qwen-1b5").textContent).toContain("1.1 GB");
    expect(within(row("gemma-3-4b")).getByRole("radio").getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector("[data-brain-claude]")!.textContent).toBe(
      "adversum.brain.claude.found",
    );
    expect(document.querySelector("[data-brain-no-helper]")).toBeNull();

    fireEvent.click(within(row("qwen-1b5")).getByRole("radio"));
    expect(mocks.settings.update).toHaveBeenCalledWith("brainModel", "qwen-1b5");
    fireEvent.click(screen.getByText("adversum.brain.modeOption.auto"));
    expect(mocks.settings.update).toHaveBeenCalledWith("multiModel", "auto");
  });

  it("downloads with progress, can cancel, and reports a failure", async () => {
    await renderSection();
    fireEvent.click(within(row("gemma-3-4b")).getByRole("button", { name: /downloadLabel/ }));
    expect(mocks.downloadBrainModel).toHaveBeenCalledWith("gemma-3-4b");
    expect(within(row("gemma-3-4b")).getByRole("status").textContent).toBe(
      "adversum.voice.settings.downloading:0",
    );
    // While one file loads, no other can be started.
    expect(
      (within(row("qwen-1b5")).getByRole("button", { name: /downloadLabel/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    act(() =>
      handlers[VOICE_DOWNLOAD_EVENT]!({
        payload: { model: "gemma-3-4b", state: "progress", received: 500, total: 2000 },
      }),
    );
    expect(within(row("gemma-3-4b")).getByRole("status").textContent).toBe(
      "adversum.voice.settings.downloading:25",
    );
    fireEvent.click(screen.getByText("adversum.voice.settings.cancel"));
    expect(mocks.cancelVoiceDownload).toHaveBeenCalledTimes(1);

    status = { ...baseStatus, models: [{ ...baseStatus.models[0]!, installed: true }, baseStatus.models[1]!] };
    await act(async () =>
      handlers[VOICE_DOWNLOAD_EVENT]!({
        payload: { model: "gemma-3-4b", state: "done", received: 2000, total: 2000 },
      }),
    );
    expect(within(row("gemma-3-4b")).getByText("adversum.voice.settings.installed")).toBeTruthy();

    await act(async () =>
      handlers[VOICE_DOWNLOAD_EVENT]!({
        payload: { model: "qwen-1b5", state: "failed", received: 0, total: 0 },
      }),
    );
    expect(screen.getByRole("alert").textContent).toBe("adversum.voice.settings.downloadFailed");
    // A failing native call is no reason to break the page.
    mocks.downloadBrainModel.mockRejectedValue(new Error("offline"));
    mocks.cancelVoiceDownload.mockRejectedValue(new Error("offline"));
    fireEvent.click(within(row("qwen-1b5")).getByRole("button", { name: /downloadLabel/ }));
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByText("adversum.voice.settings.cancel"));
    await act(async () => undefined);
  });

  it("deletes a model", async () => {
    status = { ...baseStatus, models: baseStatus.models.map((model) => ({ ...model, installed: true })) };
    mocks.deleteBrainModel.mockImplementation(async () => {
      status = { ...baseStatus };
    });
    await renderSection();
    fireEvent.click(within(row("qwen-1b5")).getByRole("button", { name: /deleteLabel/ }));
    await waitFor(() =>
      expect(within(row("qwen-1b5")).getByText("adversum.voice.settings.download")).toBeTruthy(),
    );
    expect(mocks.deleteBrainModel).toHaveBeenCalledWith("qwen-1b5");
    mocks.deleteBrainModel.mockRejectedValue(new Error("busy"));
    status = { ...baseStatus, models: baseStatus.models.map((model) => ({ ...model, installed: true })) };
    await act(async () =>
      handlers[VOICE_DOWNLOAD_EVENT]!({ payload: { model: "x", state: "cancelled", received: 0, total: 0 } }),
    );
    fireEvent.click(within(row("gemma-3-4b")).getByRole("button", { name: /deleteLabel/ }));
    await act(async () => undefined);
    expect(within(row("gemma-3-4b")).getByText("adversum.voice.settings.installed")).toBeTruthy();
  });

  it("changes and resets the folder, and says when it is on a disk that is not connected", async () => {
    await renderSection();
    expect(document.querySelector("[data-brain-dir]")!.textContent).toBe(baseStatus.modelDir);
    expect(screen.queryByText("adversum.voice.settings.resetFolder")).toBeNull();
    // Nothing chosen changes nothing.
    fireEvent.click(screen.getByText("adversum.voice.settings.chooseFolder"));
    await act(async () => undefined);
    expect(mocks.settings.update).not.toHaveBeenCalled();
    mocks.chooseVoiceModelDir.mockResolvedValue("/Volumes/Adversum /KI");
    fireEvent.click(screen.getByText("adversum.voice.settings.chooseFolder"));
    await waitFor(() =>
      expect(mocks.settings.update).toHaveBeenCalledWith("brainModelDir", "/Volumes/Adversum /KI"),
    );
    // A folder the native side refuses is reported; a failing dialog is not.
    mocks.settings.update.mockResolvedValue(false);
    fireEvent.click(screen.getByText("adversum.voice.settings.chooseFolder"));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("adversum.voice.settings.folderRejected"),
    );
    mocks.chooseVoiceModelDir.mockRejectedValue(new Error("no dialog"));
    fireEvent.click(screen.getByText("adversum.voice.settings.chooseFolder"));
    await act(async () => undefined);
    expect(screen.queryByRole("alert")).toBeNull();

    cleanup();
    mocks.settings.update = vi.fn().mockResolvedValue(true);
    useSettings({ brainModelDir: "/Volumes/Extern/KI" });
    status = { ...baseStatus, modelDir: "/Volumes/Extern/KI", modelVolume: "Extern", helper: false };
    await renderSection();
    expect(document.querySelector("[data-brain-volume]")!.textContent).toBe(
      "adversum.brain.modelVolume:Extern",
    );
    expect(document.querySelector("[data-brain-no-helper]")).not.toBeNull();
    fireEvent.click(screen.getByText("adversum.brain.useInternal"));
    fireEvent.click(screen.getByText("adversum.voice.settings.resetFolder"));
    expect(mocks.settings.update.mock.calls).toEqual([
      ["brainModelDir", ""],
      ["brainModelDir", ""],
    ]);
  });

  it("shows nothing without the native side and survives a window without events", async () => {
    mocks.getBrainStatus.mockRejectedValue(new Error("no native side"));
    mocks.getMultiModelStatus.mockRejectedValue(new Error("no native side"));
    mocks.listen.mockRejectedValue(new Error("no events"));
    const { container, unmount } = await renderSection();
    expect(container.innerHTML).toBe("");
    unmount();
    await act(async () => undefined);
  });
});
