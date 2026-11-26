// @vitest-environment jsdom

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KimaiClient } from "../../api/kimaiClient";
import type { KimaiTimesheetEntry } from "../../api/kimaiTypes";

const getTimesheets = vi.hoisted(() => vi.fn());
vi.mock("../../api/timesheetApi", () => ({ getTimesheets }));

import { sortEntries, useDayEntries } from "./useDayEntries";

const entry = (fields: Partial<KimaiTimesheetEntry>): KimaiTimesheetEntry =>
  ({
    id: 1,
    begin: "2026-11-26T09:00:00+0100",
    end: "2026-11-26T10:00:00+0100",
    project: 11,
    activity: 4,
    description: null,
    ...fields,
  }) as KimaiTimesheetEntry;

const client = { cacheScope: "test" } as KimaiClient;

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 1 } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => vi.clearAllMocks());

describe("sortEntries", () => {
  it("separates finished entries from the running timer", () => {
    const sorted = sortEntries([
      entry({ id: 1 }),
      entry({ id: 2, begin: "2026-11-26T11:00:00+0100", end: null, description: "Startseite" }),
      // Should two run, the newer one is the timer.
      entry({ id: 3, begin: "2026-11-26T13:00:00+0100", end: null, project: 21, activity: 5 }),
      entry({ id: 4, begin: "2026-11-26T12:00:00+0100", end: null }),
    ]);
    expect(sorted.busy).toEqual([
      {
        begin: new Date("2026-11-26T09:00:00+01:00").getTime(),
        end: new Date("2026-11-26T10:00:00+01:00").getTime(),
      },
    ]);
    expect(sorted.running).toEqual({
      id: 3,
      projectId: 21,
      activityId: 5,
      description: "",
      begin: new Date("2026-11-26T13:00:00+01:00"),
    });
    expect(sortEntries([])).toEqual({ busy: [], running: null });
  });
});

describe("useDayEntries", () => {
  it("loads the entries of that day", async () => {
    getTimesheets.mockResolvedValue([entry({ id: 1 })]);
    const { result } = renderHook(() => useDayEntries(client, new Date(2026, 10, 26, 14, 20)), {
      wrapper,
    });
    expect(result.current).toEqual({ busy: [], running: null, ready: false });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.busy).toHaveLength(1);
    expect(getTimesheets).toHaveBeenCalledWith(client, {
      begin: "2026-11-26T00:00:00",
      end: "2026-11-26T23:59:59",
      size: 200,
    });
  });

  it("goes on without them when Kimai does not answer, or without a connection", async () => {
    getTimesheets.mockRejectedValue(new Error("offline"));
    const failing = renderHook(() => useDayEntries(client, new Date(2026, 10, 26)), { wrapper });
    await waitFor(() => expect(failing.result.current.ready).toBe(true));
    expect(failing.result.current.busy).toEqual([]);

    const offline = renderHook(() => useDayEntries(null, new Date(2026, 10, 26)), { wrapper });
    expect(offline.result.current).toEqual({ busy: [], running: null, ready: true });
  });
});
