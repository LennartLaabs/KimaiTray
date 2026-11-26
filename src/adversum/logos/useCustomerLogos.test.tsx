// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KimaiClient } from "../../api/kimaiClient";
import type { LogoChange, LogoEntry } from "./logoApi";

const mocks = vi.hoisted(() => ({
  listLogos: vi.fn(),
  fetchLogo: vi.fn(),
  onLogoChange: vi.fn(),
  getCustomerHomepage: vi.fn(),
  loggerError: vi.fn(),
  loggerDebug: vi.fn(),
}));
vi.mock("./logoApi", () => ({
  listLogos: mocks.listLogos,
  fetchLogo: mocks.fetchLogo,
  onLogoChange: mocks.onLogoChange,
}));
vi.mock("./customerHomepage", () => ({ getCustomerHomepage: mocks.getCustomerHomepage }));
vi.mock("../../utils/logger", () => ({
  logger: { error: mocks.loggerError, debug: mocks.loggerDebug },
}));

import { needsLogoFetch, useCustomerLogos } from "./useCustomerLogos";

function entry(customerId: number, overrides: Partial<LogoEntry> = {}): LogoEntry {
  return {
    customerId,
    source: "homepage",
    dataUrl: `data:image/png;base64,${customerId}`,
    stale: false,
    triedLogoDev: false,
    ...overrides,
  };
}

function client(connectionId = "conn", cacheScope = `${connectionId}:1`): KimaiClient {
  return { connectionId, cacheScope } as unknown as KimaiClient;
}

let emitChange: (change: LogoChange) => void;
let unlisten: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  unlisten = vi.fn();
  mocks.listLogos.mockResolvedValue([]);
  mocks.onLogoChange.mockImplementation(async (callback: (change: LogoChange) => void) => {
    emitChange = callback;
    return unlisten;
  });
  mocks.getCustomerHomepage.mockImplementation(async (_client, id: number) => `site${id}.example`);
  mocks.fetchLogo.mockImplementation(async ({ customerId }) => entry(customerId));
});
afterEach(cleanup);

describe("needsLogoFetch", () => {
  it("fetches unknown, expired and not-yet-asked logos, but never manual ones", () => {
    expect(needsLogoFetch(undefined, false)).toBe(true);
    expect(needsLogoFetch(entry(1), false)).toBe(false);
    expect(needsLogoFetch(entry(1, { stale: true }), false)).toBe(true);
    expect(needsLogoFetch(entry(1), true)).toBe(true);
    expect(needsLogoFetch(entry(1, { triedLogoDev: true }), true)).toBe(false);
    expect(needsLogoFetch(entry(1, { source: "manual", stale: true }), true)).toBe(false);
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
    // Events are ignored until the connection's cache has been read.
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
    expect(mocks.fetchLogo).not.toHaveBeenCalled();
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

  it("fetches missing logos one after another in the background", async () => {
    mocks.listLogos.mockResolvedValue([entry(1), entry(3, { stale: true })]);
    mocks.fetchLogo.mockImplementation(async ({ customerId }) => {
      if (customerId === 2) throw new Error("offline");
      return entry(customerId, { triedLogoDev: true });
    });
    const active = client();
    const { result, rerender } = renderHook(
      ({ customerIds }) =>
        useCustomerLogos({ ...base, customerIds, client: active, autoFetch: true }),
      { initialProps: { customerIds: [3, 1, 2] } },
    );
    await waitFor(() => expect(mocks.fetchLogo).toHaveBeenCalledTimes(2));
    expect(mocks.fetchLogo.mock.calls.map(([request]) => request.customerId)).toEqual([2, 3]);
    expect(mocks.fetchLogo).toHaveBeenCalledWith({
      connectionId: "conn",
      customerId: 3,
      homepage: "site3.example",
      logoDevToken: null,
      force: false,
    });
    expect(mocks.getCustomerHomepage).toHaveBeenCalledWith(active, 3);
    expect(mocks.loggerDebug).toHaveBeenCalledWith(
      "Logo fetch failed for customer 2: Error: offline",
    );
    await waitFor(() => expect(result.current.entries.get(3)?.stale).toBe(false));

    // The failed customer is not retried within the session, new ones are.
    rerender({ customerIds: [3, 1, 2, 4] });
    await waitFor(() => expect(mocks.fetchLogo).toHaveBeenCalledTimes(3));
    expect(mocks.fetchLogo.mock.calls[2]![0].customerId).toBe(4);
    rerender({ customerIds: [3, 1, 2, 4] });
    expect(mocks.fetchLogo).toHaveBeenCalledTimes(3);
  });

  it("asks logo.dev again once a key is added or corrected", async () => {
    mocks.listLogos.mockResolvedValue([entry(1)]);
    const active = client();
    const { rerender } = renderHook(
      ({ logoDevToken }) =>
        useCustomerLogos({
          ...base, customerIds: [1], client: active, autoFetch: true, logoDevToken,
        }),
      { initialProps: { logoDevToken: "" } },
    );
    await waitFor(() => expect(mocks.listLogos).toHaveBeenCalled());
    expect(mocks.fetchLogo).not.toHaveBeenCalled();

    rerender({ logoDevToken: "pk_wrong" });
    await waitFor(() => expect(mocks.fetchLogo).toHaveBeenCalledTimes(1));
    expect(mocks.fetchLogo.mock.calls[0]![0].logoDevToken).toBe("pk_wrong");
    rerender({ logoDevToken: "pk_right" });
    await waitFor(() => expect(mocks.fetchLogo).toHaveBeenCalledTimes(2));
    expect(mocks.fetchLogo.mock.calls[1]![0].logoDevToken).toBe("pk_right");
  });

  it("does not fetch for another connection's client and stops when the list changes", async () => {
    mocks.listLogos.mockResolvedValue([]);
    const { rerender } = renderHook(
      ({ active, customerIds }) =>
        useCustomerLogos({ ...base, customerIds, client: active, autoFetch: true }),
      { initialProps: { active: client("other"), customerIds: [1, 2] as number[] } },
    );
    await waitFor(() => expect(mocks.listLogos).toHaveBeenCalled());
    await act(async () => undefined);
    expect(mocks.fetchLogo).not.toHaveBeenCalled();

    let releaseFirst: () => void = () => undefined;
    mocks.getCustomerHomepage.mockImplementationOnce(
      () => new Promise<string>((resolve) => { releaseFirst = () => resolve("first.example"); }),
    );
    rerender({ active: client(), customerIds: [1, 2] });
    await waitFor(() => expect(mocks.getCustomerHomepage).toHaveBeenCalledTimes(1));
    rerender({ active: client(), customerIds: [] });
    await act(async () => releaseFirst());
    expect(mocks.fetchLogo).toHaveBeenCalledTimes(1);
    expect(mocks.fetchLogo.mock.calls[0]![0].customerId).toBe(1);
  });

  it("stops the background queue when the connection changes", async () => {
    let releaseFirst: () => void = () => undefined;
    mocks.getCustomerHomepage.mockImplementationOnce(
      () => new Promise<string>((resolve) => { releaseFirst = () => resolve("first.example"); }),
    );
    const { rerender } = renderHook(
      ({ connectionId }) =>
        useCustomerLogos({
          ...base, connectionId, customerIds: [1, 2], client: client("conn"), autoFetch: true,
        }),
      { initialProps: { connectionId: "conn" } },
    );
    await waitFor(() => expect(mocks.getCustomerHomepage).toHaveBeenCalledTimes(1));
    rerender({ connectionId: "next" });
    await act(async () => releaseFirst());
    expect(mocks.fetchLogo).toHaveBeenCalledTimes(1);
  });

  it("reloads a single logo on request, ignoring the cache", async () => {
    mocks.listLogos.mockResolvedValue([entry(1)]);
    mocks.fetchLogo.mockResolvedValue(entry(1, { source: "logodev" }));
    const { result } = renderHook(() =>
      useCustomerLogos({ ...base, client: client(), logoDevToken: "pk_live" }),
    );
    await waitFor(() => expect(result.current.entries.size).toBe(1));
    await act(() => result.current.reload(1));
    expect(mocks.fetchLogo).toHaveBeenCalledWith({
      connectionId: "conn",
      customerId: 1,
      homepage: "site1.example",
      logoDevToken: "pk_live",
      force: true,
    });
    expect(result.current.entries.get(1)?.source).toBe("logodev");
  });
});
