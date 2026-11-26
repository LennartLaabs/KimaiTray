// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KimaiClient } from "../../api/kimaiClient";

const mocks = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("./customerHomepage", () => ({ lookupCustomerHomepage: mocks.lookup }));

import { useCustomerHomepages } from "./useCustomerHomepages";

const client = { connectionId: "conn", cacheScope: "conn:1" } as unknown as KimaiClient;

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lookup.mockImplementation(async (_client: KimaiClient, id: number) => ({
    homepage: id === 2 ? null : `https://site${id}.example`,
    failed: id === 3,
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useCustomerHomepages", () => {
  it("reads the homepage of every customer once", async () => {
    const { result } = renderHook(
      () => useCustomerHomepages(client, true, [3, 1, 2, 1, 5, 4, 6]),
      { wrapper },
    );
    expect(result.current.lookups).toBeUndefined();
    await waitFor(() => expect(result.current.lookups?.size).toBe(6));
    expect(mocks.lookup).toHaveBeenCalledTimes(6);
    expect(result.current.lookups!.get(1)).toEqual({ homepage: "https://site1.example", failed: false });
    expect(result.current.lookups!.get(2)).toEqual({ homepage: null, failed: false });
    expect(result.current.lookups!.get(3)?.failed).toBe(true);
    expect(result.current.updatedAt).toBeGreaterThan(0);
  });

  it("asks nothing while disabled, without a client or without customers", async () => {
    renderHook(() => useCustomerHomepages(client, false, [1]), { wrapper });
    renderHook(() => useCustomerHomepages(null, true, [1]), { wrapper });
    const { result } = renderHook(() => useCustomerHomepages(client, true, []), { wrapper });
    await Promise.resolve();
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(result.current.lookups).toBeUndefined();
    // Nothing to record a single lookup into yet.
    act(() => result.current.remember(1, { homepage: "x", failed: false }));
    expect(result.current.lookups).toBeUndefined();
  });

  it("reads again on request only once the last round is a minute old", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useCustomerHomepages(client, true, [1]), { wrapper });
    await waitFor(() => expect(result.current.lookups?.size).toBe(1));
    act(() => result.current.refreshIfStale());
    expect(mocks.lookup).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(61_000));
    mocks.lookup.mockResolvedValue({ homepage: "https://new.example", failed: false });
    act(() => result.current.refreshIfStale());
    await waitFor(() =>
      expect(result.current.lookups?.get(1)?.homepage).toBe("https://new.example"),
    );
    expect(mocks.lookup).toHaveBeenCalledTimes(2);
  });

  it("reads again by itself every five minutes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useCustomerHomepages(client, true, [1]), { wrapper });
    await waitFor(() => expect(result.current.lookups?.size).toBe(1));
    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000 + 500));
    await waitFor(() => expect(mocks.lookup).toHaveBeenCalledTimes(2));
  });

  it("records a lookup made for a single customer", async () => {
    const { result } = renderHook(() => useCustomerHomepages(client, true, [1, 2]), { wrapper });
    await waitFor(() => expect(result.current.lookups?.size).toBe(2));
    act(() => result.current.remember(2, { homepage: "https://two.example", failed: false }));
    await waitFor(() =>
      expect(result.current.lookups?.get(2)?.homepage).toBe("https://two.example"),
    );
    expect(result.current.lookups?.get(1)?.homepage).toBe("https://site1.example");
  });
});
