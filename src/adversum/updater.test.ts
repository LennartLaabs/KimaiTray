import { afterEach, describe, expect, it, vi } from "vitest";

const check = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-updater", () => ({ check }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(), listen: vi.fn() }));

describe("adversum updater switch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    check.mockReset();
  });

  it("keeps the upstream updater path available to upstream tests", async () => {
    const { adversumUpdaterEnabled } = await import("./updater");
    expect(adversumUpdaterEnabled()).toBe(true);
  });

  it("never asks the updater plugin for an update in a real build", async () => {
    vi.stubEnv("MODE", "production");
    const { adversumUpdaterEnabled } = await import("./updater");
    const { checkForUpdate } = await import("../api/updater");

    expect(adversumUpdaterEnabled()).toBe(false);
    await expect(checkForUpdate()).resolves.toBeNull();
    expect(check).not.toHaveBeenCalled();
  });

  it("ships with automatic updates switched off by default", async () => {
    vi.stubEnv("MODE", "production");
    const { defaultSettings, mergeSettings } = await import("../settings/service");
    expect(defaultSettings.autoUpdate).toBe(false);
    expect(mergeSettings().autoUpdate).toBe(false);
    expect(mergeSettings({ theme: "dark" }).autoUpdate).toBe(false);
  });
});
