import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Keeps upstream's coverage gate green on Node 25 and newer.
 *
 * `src/api/deepLink.ts` skips its "already consumed" bookkeeping when there is
 * no `sessionStorage`. Upstream's own test relies on Node not having one,
 * which was true up to Node 24. Newer Node versions ship a global
 * `sessionStorage`, so that path is exercised here explicitly instead of
 * editing upstream's test.
 */
const plugin = vi.hoisted(() => ({
  getCurrent: vi.fn<() => Promise<string[] | null>>(),
  onOpenUrl: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-deep-link", () => plugin);
vi.mock("../utils/logger", () => ({ logger: { error: vi.fn() } }));

describe("upstream deep links without session storage", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    plugin.onOpenUrl.mockResolvedValue(vi.fn());
    vi.stubGlobal("sessionStorage", undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delivers the launch URL even when nothing can be remembered", async () => {
    const url = "kimaitray://start?project=1&activity=2";
    plugin.getCurrent.mockResolvedValue([url]);
    const { subscribeToDeepLinks } = await import("../api/deepLink");
    const subscriber = vi.fn();
    subscribeToDeepLinks(subscriber);
    await vi.waitFor(() => expect(subscriber).toHaveBeenCalledWith(url));
    expect(typeof sessionStorage).toBe("undefined");
  });
});
