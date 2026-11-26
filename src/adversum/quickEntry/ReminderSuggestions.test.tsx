// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAdversumSettings } from "../settings/adversumSettings";

const mocks = vi.hoisted(() => ({
  getProjects: vi.fn(),
  getCustomers: vi.fn(),
  getActivities: vi.fn(),
  fetchHistory: vi.fn(),
  emitTo: vi.fn(),
  loggerError: vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../../hooks/useKimaiClient", () => ({
  useKimaiClient: () => ({
    client: { connectionId: "conn", cacheScope: "conn:1" },
    isConfigured: true,
    activeConnectionId: "conn",
  }),
}));
vi.mock("../settings/useAdversumSettings", () => ({
  useAdversumSettings: () => ({ settings: defaultAdversumSettings }),
}));
vi.mock("../../api/projectApi", () => ({
  getProjects: mocks.getProjects,
  getCustomers: mocks.getCustomers,
}));
vi.mock("../../api/activityApi", () => ({ getActivities: mocks.getActivities }));
vi.mock("./quickApi", () => ({ fetchHistory: mocks.fetchHistory }));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: mocks.emitTo }));
vi.mock("../../utils/logger", () => ({ logger: { error: mocks.loggerError } }));

import { setAdversumDisplay } from "../display/displayStore";
import { QUICK_EXECUTE_EVENT } from "./quickEvents";
import ReminderSuggestions from "./ReminderSuggestions";

const display = {
  indicator: "logo" as const,
  customersByProject: new Map(),
  logos: new Map([[1, "data:image/png;base64,AAAA"]]),
};
const DAY = 86_400_000;

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCustomers.mockResolvedValue([{ id: 1, name: "DUSW" }, { id: 2, name: "Herosmile" }]);
  mocks.getProjects.mockResolvedValue([
    { id: 11, name: "Retainer", customer: 1 },
    { id: 21, name: "Social", customer: 2 },
  ]);
  mocks.getActivities.mockResolvedValue([{ id: 1, name: "Projektmanagement", project: null }]);
  mocks.fetchHistory.mockResolvedValue([
    { projectId: 11, activityId: 1, begin: new Date(Date.now() - DAY) },
    { projectId: 11, activityId: 1, begin: new Date(Date.now() - 2 * DAY) },
    { projectId: 21, activityId: 1, begin: new Date(Date.now() - DAY) },
  ]);
  mocks.emitTo.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  setAdversumDisplay(null);
});

describe("ReminderSuggestions", () => {
  it("renders nothing outside the running app", () => {
    const { container } = render(<ReminderSuggestions onStarted={vi.fn()} />, { wrapper });
    expect(container.innerHTML).toBe("");
  });

  it("offers the likeliest tasks and starts one with a click", async () => {
    setAdversumDisplay(display);
    const onStarted = vi.fn();
    render(<ReminderSuggestions onStarted={onStarted} />, { wrapper });
    const buttons = await screen.findAllByRole("button");
    // Two combinations have history; the more frequent one comes first.
    expect(buttons.map((button) => button.textContent)).toEqual([
      "DUSWRetainer · Projektmanagement",
      // No logo cached for this customer: initials stand in.
      "HEHerosmileSocial · Projektmanagement",
    ]);
    expect(buttons[0]!.querySelector("img")).not.toBeNull();
    expect(screen.getByText("adversum.reminder.title")).toBeTruthy();

    fireEvent.click(buttons[1]!);
    expect(mocks.emitTo).toHaveBeenCalledWith("tray-popup", QUICK_EXECUTE_EVENT, {
      action: expect.objectContaining({ type: "start", mode: "switch", projectId: 21, begin: null }),
    });
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it("shows nothing without history and logs a failed hand-over", async () => {
    setAdversumDisplay(display);
    mocks.fetchHistory.mockResolvedValue([]);
    const first = render(<ReminderSuggestions onStarted={vi.fn()} />, { wrapper });
    await waitFor(() => expect(mocks.getActivities).toHaveBeenCalled());
    await act(async () => undefined);
    expect(first.container.innerHTML).toBe("");
    first.unmount();

    mocks.fetchHistory.mockResolvedValue([{ projectId: 11, activityId: 1, begin: new Date(Date.now() - DAY) }]);
    mocks.emitTo.mockRejectedValue(new Error("tray gone"));
    render(<ReminderSuggestions onStarted={vi.fn()} />, { wrapper });
    fireEvent.click(await screen.findByRole("button"));
    await waitFor(() =>
      expect(mocks.loggerError).toHaveBeenCalledWith("Reminder start failed: Error: tray gone"),
    );
  });
});
