// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAdversumSettings, type AdversumSettings } from "./adversumSettings";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  patch: vi.fn(),
  onChange: vi.fn(),
  loggerError: vi.fn(),
}));
vi.mock("../../utils/logger", () => ({ logger: { error: mocks.loggerError } }));
vi.mock("./adversumSettings", async () => ({
  ...(await vi.importActual<typeof import("./adversumSettings")>("./adversumSettings")),
  loadAdversumSettings: mocks.load,
  patchAdversumSettings: mocks.patch,
  onAdversumSettingsChange: mocks.onChange,
}));

import { useAdversumSettings } from "./useAdversumSettings";

const dots: AdversumSettings = { ...defaultAdversumSettings, customerIndicator: "dots" };
let emitChange: (settings: AdversumSettings) => void;
let unlisten: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  unlisten = vi.fn();
  mocks.load.mockResolvedValue(defaultAdversumSettings);
  mocks.onChange.mockImplementation(async (callback: (settings: AdversumSettings) => void) => {
    emitChange = callback;
    return unlisten;
  });
});
afterEach(cleanup);

describe("useAdversumSettings", () => {
  it("loads the settings and follows changes from other windows", async () => {
    mocks.load.mockResolvedValue(dots);
    const { result, unmount } = renderHook(() => useAdversumSettings());
    expect(result.current.loaded).toBe(false);
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.settings.customerIndicator).toBe("dots");

    act(() => emitChange({ ...dots, logoDevToken: "pk_x" }));
    expect(result.current.settings.logoDevToken).toBe("pk_x");

    unmount();
    await waitFor(() => expect(unlisten).toHaveBeenCalled());
    act(() => emitChange(defaultAdversumSettings));
    expect(result.current.settings.logoDevToken).toBe("pk_x");
  });

  it("ignores a load that finishes after the window is gone", async () => {
    let resolveLoad: (settings: AdversumSettings) => void = () => undefined;
    mocks.load.mockReturnValue(new Promise((resolve) => { resolveLoad = resolve; }));
    mocks.onChange.mockRejectedValue(new Error("no events"));
    const { result, unmount } = renderHook(() => useAdversumSettings());
    unmount();
    await act(async () => resolveLoad(dots));
    expect(result.current.loaded).toBe(false);
  });

  it("applies an update immediately and keeps the persisted result", async () => {
    mocks.patch.mockResolvedValue({ ...dots, logoDevToken: "pk_saved" });
    const { result } = renderHook(() => useAdversumSettings());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    let saved: boolean | undefined;
    await act(async () => {
      saved = await result.current.update("customerIndicator", "dots");
    });
    expect(saved).toBe(true);
    expect(mocks.patch).toHaveBeenCalledWith({ customerIndicator: "dots" });
    expect(result.current.settings).toEqual({ ...dots, logoDevToken: "pk_saved" });
  });

  it("reverts and logs when saving fails", async () => {
    mocks.patch.mockRejectedValue(new Error("disk full"));
    const { result } = renderHook(() => useAdversumSettings());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    let saved: boolean | undefined;
    await act(async () => {
      saved = await result.current.update("customerIndicator", "dots");
    });
    expect(saved).toBe(false);
    expect(result.current.settings.customerIndicator).toBe("logo");
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "Failed to save Adversum setting customerIndicator: Error: disk full",
    );
  });
});
