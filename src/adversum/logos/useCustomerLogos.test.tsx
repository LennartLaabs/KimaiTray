// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KimaiClient } from "../../api/kimaiClient";
import type { HomepageLookup } from "./customerHomepage";
import type { LogoChange, LogoEntry } from "./logoApi";

const mocks = vi.hoisted(() => ({
  listLogos: vi.fn(),
  fetchLogo: vi.fn(),
  onLogoChange: vi.fn(),
  lookup: vi.fn(),
  loggerError: vi.fn(),
  loggerDebug: vi.fn(),
}));
vi.mock("./logoApi", () => ({
  listLogos: mocks.listLogos,
  fetchLogo: mocks.fetchLogo,
  onLogoChange: mocks.onLogoChange,
}));
vi.mock("./customerHomepage", () => ({ lookupCustomerHomepage: mocks.lookup }));
vi.mock("../../utils/logger", () => ({
  logger: { error: mocks.loggerError, debug: mocks.loggerDebug },
}));

import { needsLogoFetch, useCustomerLogos } from "./useCustomerLogos";

const NOW = 1_800_000_000;

function site(id: number): string {
  return `https://site${id}.example`;
}

function entry(customerId: number, overrides: Partial<LogoEntry> = {}): LogoEntry {
  return {
    customerId,
    source: "homepage",
    dataUrl: `data:image/png;base64,${customerId}`,
    expiresAt: NOW + 3600,
    triedLogoDev: false,
    homepage: site(customerId),
    problem: null,
    detail: null,
    ...overrides,
  };
}

function client(connectionId = "conn", cacheScope = `${connectionId}:1`): KimaiClient {
  return { connectionId, cacheScope } as unknown as KimaiClient;
}

/** Homepages as Kimai reports them: `site<id>.example` unless overridden. */
function homepagesFor(
  ids: number[],
  overrides: Record<number, Partial<HomepageLookup>> = {},
): Map<number, HomepageLookup> {
  return new Map(
    ids.map((id) => [id, { homepage: site(id), failed: false, ...overrides[id] }]),
  );
}

let emitChange: (change: LogoChange) => void;
let unlisten: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: NOW * 1000, shouldAdvanceTime: true });
  unlisten = vi.fn();
  mocks.listLogos.mockResolvedValue([]);
  mocks.onLogoChange.mockImplementation(async (callback: (change: LogoChange) => void) => {
    emitChange = callback;
    return unlisten;
  });
  mocks.lookup.mockImplementation(async (_client, id: number) => ({ homepage: site(id), failed: false }));
  mocks.fetchLogo.mockImplementation(async ({ customerId, homepage }) =>
    entry(customerId, { homepage }),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("needsLogoFetch", () => {
  it("fetches what is unknown, expired or not yet asked at logo.dev", () => {
    expect(needsLogoFetch(undefined, site(1), false, NOW)).toBe(true);
    expect(needsLogoFetch(entry(1), site(1), false, NOW)).toBe(false);
    expect(needsLogoFetch(entry(1), site(1), false, NOW + 3600)).toBe(true);
    expect(needsLogoFetch(entry(1), site(1), true, NOW)).toBe(true);
    expect(needsLogoFetch(entry(1, { triedLogoDev: true }), site(1), true, NOW)).toBe(false);
  });

  it("fetches at once when the homepage in Kimai changed", () => {
    const miss = entry(1, { source: "none", dataUrl: null, homepage: null, problem: "noHomepage" });
    expect(needsLogoFetch(miss, null, false, NOW)).toBe(false);
    // The bug report: the homepage is entered after the first lookup.
    expect(needsLogoFetch(miss, "https://dusw.de", false, NOW)).toBe(true);
    expect(needsLogoFetch(entry(1), "https://other.example", false, NOW)).toBe(true);
    expect(needsLogoFetch(entry(1), null, false, NOW)).toBe(true);
  });

  it("never replaces a manual logo", () => {
    const manual = entry(1, { source: "manual", expiresAt: null, homepage: null });
    expect(needsLogoFetch(manual, "https://dusw.de", true, NOW + 10 ** 9)).toBe(false);
  });
});

describe("useCustomerLogos", () => {
  const base = { connectionId: "conn", customerIds: [2, 1, 2], logoDevToken: "", autoFetch: false };

  it("loads the cached entries of the connection and merges change events", async () => {
    mocks.listLogos.mockResolvedValue([entry(1), entry(2, { source: "none", dataUrl: null })]);
    const { result, unmount } = renderHook(() => useCustomerLogos({ ...base, client: client() }));
    expect(result.current.entries.size).toBe(0);
    await waitFor(() => expect(result.current.entries.size).toBe(2));
    expect(mocks.listLogos).toHaveBeenCalledWith("conn");
    expect(mocks.fetchLogo).not.toHaveBeenCalled();

    act(() => emitChange({ connectionId: "conn", customerId: 3, entry: entry(3) }));
    expect(result.current.entries.get(3)?.dataUrl).toBe("data:image/png;base64,3");
    act(() => emitChange({ connectionId: "conn", customerId: 1, entry: null }));
    expect(result.current.entries.has(1)).toBe(false);
    act(() => emitChange({ connectionId: "other", customerId: 9, entry: entry(9) }));
    expect(result.current.entries.has(9)).toBe(false);

    act(() => result.current.apply(4, entry(4, { source: "manual" })));
    expect(result.current.entries.get(4)?.source).toBe("manual");

    unmount();
    await waitFor(() => expect(unlisten).toHaveBeenCalled());
  });

  it("starts empty without a connection and survives a failing cache or event channel", async () => {
    mocks.onLogoChange.mockRejectedValue(new Error("no events"));
    const { result, rerender, unmount } = renderHook(
      ({ connectionId }) => useCustomerLogos({ ...base, connectionId, client: null }),
      { initialProps: { connectionId: "" } },
    );
    expect(mocks.listLogos).not.toHaveBeenCalled();
    // Changes are ignored until the connection's cache has been read.
    act(() => result.current.apply(1, entry(1)));
    expect(result.current.entries.size).toBe(0);

    mocks.listLogos.mockRejectedValue(new Error("unreadable"));
    rerender({ connectionId: "conn" });
    await waitFor(() =>
      expect(mocks.loggerError).toHaveBeenCalledWith(
        "Failed to load cached logos: Error: unreadable",
      ),
    );
    expect(result.current.entries.size).toBe(0);
    await act(() => result.current.reload(1));
    expect(mocks.lookup).not.toHaveBeenCalled();
    unmount();
  });

  it("drops a cache read that belongs to a connection the user already left", async () => {
    let resolveList: (entries: LogoEntry[]) => void = () => undefined;
    let rejectList: (error: Error) => void = () => undefined;
    mocks.listLogos
      .mockReturnValueOnce(new Promise((resolve) => { resolveList = resolve; }))
      .mockReturnValueOnce(new Promise((_resolve, reject) => { rejectList = reject; }))
      .mockResolvedValue([entry(5)]);
    const { result, rerender } = renderHook(
      ({ connectionId }) => useCustomerLogos({ ...base, connectionId, client: null }),
      { initialProps: { connectionId: "first" } },
    );
    rerender({ connectionId: "second" });
    rerender({ connectionId: "third" });
    await act(async () => {
      resolveList([entry(1)]);
      rejectList(new Error("late"));
    });
    await waitFor(() => expect(result.current.entries.has(5)).toBe(true));
    expect(result.current.entries.has(1)).toBe(false);
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it("fetches missing and expired logos with the homepage Kimai reports", async () => {
    mocks.listLogos.mockResolvedValue([entry(1), entry(3, { expiresAt: NOW - 1 })]);
    mocks.fetchLogo.mockImplementation(async ({ customerId, homepage }) => {
      if (customerId === 2) throw new Error("offline");
      return entry(customerId, { homepage });
    });
    const active = client();
    const { result } = renderHook(() =>
      useCustomerLogos({
        ...base,
        customerIds: [3, 1, 2, 4, 5],
        client: active,
        autoFetch: true,
        // Kimai could not be asked about 4, and 5 is not in the answer at all.
        homepages: homepagesFor([1, 2, 3, 4], { 4: { failed: true } }),
      }),
    );
    await waitFor(() => expect(mocks.fetchLogo).toHaveBeenCalledTimes(2));
    expect(mocks.fetchLogo.mock.calls.map(([request]) => request.customerId)).toEqual([2, 3]);
    expect(mocks.fetchLogo).toHaveBeenCalledWith({
      connectionId: "conn",
      customerId: 3,
      homepage: site(3),
      logoDevToken: null,
      force: false,
    });
    expect(mocks.loggerDebug).toHaveBeenCalledWith(
      "Logo fetch failed for customer 2: Error: offline",
    );
    await waitFor(() => expect(result.current.entries.get(3)?.expiresAt).toBe(NOW + 3600));
    // The homepage is not read a second time for the background fetch.
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it("waits for the homepages and for the cache before fetching anything", async () => {
    const active = client();
    const { rerender } = renderHook(
      ({ homepages }: { homepages?: Map<number, HomepageLookup> }) =>
        useCustomerLogos({ ...base, customerIds: [1], client: active, autoFetch: true, homepages }),
      { initialProps: {} },
    );
    await waitFor(() => expect(mocks.listLogos).toHaveBeenCalled());
    await act(async () => undefined);
    expect(mocks.fetchLogo).not.toHaveBeenCalled();
    rerender({ homepages: homepagesFor([1]) });
    await waitFor(() => expect(mocks.fetchLogo).toHaveBeenCalledTimes(1));
  });

  it("fetches again at once when a homepage is entered or changed in Kimai", async () => {
    mocks.listLogos.mockResolvedValue([
      entry(1, { source: "none", dataUrl: null, homepage: null, problem: "noHomepage" }),
    ]);
    const active = client();
    const { result, rerender } = renderHook(
      ({ homepages, updatedAt }: { homepages: Map<number, HomepageLookup>; updatedAt: number }) =>
        useCustomerLogos({
          ...base, customerIds: [1], client: active, autoFetch: true,
          homepages, homepagesUpdatedAt: updatedAt,
        }),
      { initialProps: { homepages: homepagesFor([1], { 1: { homepage: null } }), updatedAt: 1 } },
    );
    await waitFor(() => expect(result.current.entries.size).toBe(1));
    await act(async () => undefined);
    expect(mocks.fetchLogo).not.toHaveBeenCalled();

    rerender({ homepages: homepagesFor([1], { 1: { homepage: "https://dusw.de" } }), updatedAt: 2 });
    await waitFor(() => expect(mocks.fetchLogo).toHaveBeenCalledTimes(1));
    expect(mocks.fetchLogo.mock.calls[0]![0]).toMatchObject({ customerId: 1, homepage: "https://dusw.de" });
    await waitFor(() => expect(result.current.entries.get(1)?.homepage).toBe("https://dusw.de"));

    rerender({ homepages: homepagesFor([1], { 1: { homepage: "https://www.dusw.de" } }), updatedAt: 3 });
    await waitFor(() => expect(mocks.fetchLogo).toHaveBeenCalledTimes(2));
    expect(mocks.fetchLogo.mock.calls[1]![0].homepage).toBe("https://www.dusw.de");
  });

  it("repeats a lookup without result after an hour, not on every refresh", async () => {
    const miss = (expiresAt: number) =>
      entry(1, { source: "none", dataUrl: null, problem: "noIcon", expiresAt });
    mocks.listLogos.mockResolvedValue([miss(NOW + 3600)]);
    mocks.fetchLogo.mockImplementation(async () => miss(Math.floor(Date.now() / 1000) + 3600));
    const active = client();
    const homepages = homepagesFor([1]);
    const { result, rerender } = renderHook(
      ({ updatedAt }: { updatedAt: number }) =>
        useCustomerLogos({
          ...base, customerIds: [1], client: active, autoFetch: true,
          homepages, homepagesUpdatedAt: updatedAt,
        }),
      { initialProps: { updatedAt: 1 } },
    );
    await waitFor(() => expect(result.current.entries.size).toBe(1));
    // Homepages are re-read every few minutes; a fresh miss stays as it is.
    await act(() => vi.advanceTimersByTimeAsync(30 * 60_000));
    rerender({ updatedAt: 2 });
    await act(async () => undefined);
    expect(mocks.fetchLogo).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(31 * 60_000));
    rerender({ updatedAt: 3 });
    await waitFor(() => expect(mocks.fetchLogo).toHaveBeenCalledTimes(1));
  });

  it("does not hammer a lookup that keeps failing", async () => {
    mocks.fetchLogo.mockRejectedValue(new Error("offline"));
    const active = client();
    const homepages = homepagesFor([1]);
    const { rerender } = renderHook(
      ({ updatedAt }: { updatedAt: number }) =>
        useCustomerLogos({
          ...base, customerIds: [1], client: active, autoFetch: true,
          homepages, homepagesUpdatedAt: updatedAt,
        }),
      { initialProps: { updatedAt: 1 } },
    );
    await waitFor(() => expect(mocks.fetchLogo).toHaveBeenCalledTimes(1));
    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
    rerender({ updatedAt: 2 });
    await act(async () => undefined);
    expect(mocks.fetchLogo).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(6 * 60_000));
    rerender({ updatedAt: 3 });
    await waitFor(() => expect(mocks.fetchLogo).toHaveBeenCalledTimes(2));
  });

  it("asks logo.dev again once a key is added or corrected", async () => {
    mocks.listLogos.mockResolvedValue([entry(1)]);
    const active = client();
    const homepages = homepagesFor([1]);
    const { rerender } = renderHook(
      ({ logoDevToken }) =>
        useCustomerLogos({
          ...base, customerIds: [1], client: active, autoFetch: true, logoDevToken, homepages,
        }),
      { initialProps: { logoDevToken: "" } },
    );
    await waitFor(() => expect(mocks.listLogos).toHaveBeenCalled());
    await act(async () => undefined);
    expect(mocks.fetchLogo).not.toHaveBeenCalled();

    rerender({ logoDevToken: "pk_wrong" });
    await waitFor(() => expect(mocks.fetchLogo).toHaveBeenCalledTimes(1));
    expect(mocks.fetchLogo.mock.calls[0]![0].logoDevToken).toBe("pk_wrong");
    rerender({ logoDevToken: "pk_right" });
    await waitFor(() => expect(mocks.fetchLogo).toHaveBeenCalledTimes(2));
    expect(mocks.fetchLogo.mock.calls[1]![0].logoDevToken).toBe("pk_right");
  });

  it("does not fetch for another connection's client and stops when the list changes", async () => {
    const homepages = homepagesFor([1, 2]);
    const { rerender } = renderHook(
      ({ active, customerIds }) =>
        useCustomerLogos({ ...base, customerIds, client: active, autoFetch: true, homepages }),
      { initialProps: { active: client("other"), customerIds: [1, 2] as number[] } },
    );
    await waitFor(() => expect(mocks.listLogos).toHaveBeenCalled());
    await act(async () => undefined);
    expect(mocks.fetchLogo).not.toHaveBeenCalled();

    let releaseFirst: () => void = () => undefined;
    mocks.fetchLogo.mockImplementationOnce(
      () => new Promise<LogoEntry>((resolve) => { releaseFirst = () => resolve(entry(1)); }),
    );
    rerender({ active: client(), customerIds: [1, 2] });
    await waitFor(() => expect(mocks.fetchLogo).toHaveBeenCalledTimes(1));
    rerender({ active: client(), customerIds: [] });
    await act(async () => releaseFirst());
    expect(mocks.fetchLogo).toHaveBeenCalledTimes(1);
  });

  it("stops the background queue when the connection changes", async () => {
    let releaseFirst: () => void = () => undefined;
    mocks.fetchLogo.mockImplementationOnce(
      () => new Promise<LogoEntry>((resolve) => { releaseFirst = () => resolve(entry(1)); }),
    );
    const homepages = homepagesFor([1, 2]);
    const { rerender } = renderHook(
      ({ connectionId }) =>
        useCustomerLogos({
          ...base, connectionId, customerIds: [1, 2], client: client("conn"), autoFetch: true, homepages,
        }),
      { initialProps: { connectionId: "conn" } },
    );
    await waitFor(() => expect(mocks.fetchLogo).toHaveBeenCalledTimes(1));
    rerender({ connectionId: "next" });
    await act(async () => releaseFirst());
    expect(mocks.fetchLogo).toHaveBeenCalledTimes(1);
  });

  it("reloads a single logo with a fresh homepage from Kimai, ignoring the cache", async () => {
    mocks.listLogos.mockResolvedValue([entry(1)]);
    mocks.lookup.mockResolvedValue({ homepage: "https://dusw.de", failed: false });
    mocks.fetchLogo.mockResolvedValue(entry(1, { source: "logodev", homepage: "https://dusw.de" }));
    const onHomepageLookup = vi.fn();
    const active = client();
    const { result } = renderHook(() =>
      useCustomerLogos({ ...base, client: active, logoDevToken: "pk_live", onHomepageLookup }),
    );
    await waitFor(() => expect(result.current.entries.size).toBe(1));
    await act(() => result.current.reload(1));
    expect(mocks.lookup).toHaveBeenCalledWith(active, 1);
    expect(onHomepageLookup).toHaveBeenCalledWith(1, { homepage: "https://dusw.de", failed: false });
    expect(mocks.fetchLogo).toHaveBeenCalledWith({
      connectionId: "conn",
      customerId: 1,
      homepage: "https://dusw.de",
      logoDevToken: "pk_live",
      force: true,
    });
    expect(result.current.entries.get(1)?.source).toBe("logodev");
  });

  it("fails a reload when Kimai cannot be asked for the homepage", async () => {
    mocks.lookup.mockResolvedValue({ homepage: null, failed: true });
    const { result } = renderHook(() => useCustomerLogos({ ...base, client: client() }));
    await waitFor(() => expect(mocks.listLogos).toHaveBeenCalled());
    await expect(result.current.reload(1)).rejects.toThrow(
      "The homepage could not be read from Kimai",
    );
    expect(mocks.fetchLogo).not.toHaveBeenCalled();
  });
});
