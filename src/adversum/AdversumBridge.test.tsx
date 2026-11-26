// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAdversumSettings } from "./settings/adversumSettings";

const mocks = vi.hoisted(() => ({
  kimai: {
    client: { connectionId: "conn", cacheScope: "conn:1" } as unknown,
    isConfigured: true,
    activeConnectionId: "conn",
  },
  settings: { settings: {} as unknown, loaded: true },
  getProjects: vi.fn(),
  getCustomers: vi.fn(),
  useCustomerLogos: vi.fn(),
}));
vi.mock("../hooks/useKimaiClient", () => ({ useKimaiClient: () => mocks.kimai }));
vi.mock("./settings/useAdversumSettings", () => ({
  useAdversumSettings: () => mocks.settings,
}));
vi.mock("../api/projectApi", () => ({
  getProjects: mocks.getProjects,
  getCustomers: mocks.getCustomers,
}));
vi.mock("./logos/useCustomerLogos", () => ({ useCustomerLogos: mocks.useCustomerLogos }));

import AdversumBridge from "./AdversumBridge";
import { getAdversumDisplay, setAdversumDisplay } from "./display/displayStore";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.kimai = {
    client: { connectionId: "conn", cacheScope: "conn:1" },
    isConfigured: true,
    activeConnectionId: "conn",
  };
  mocks.settings = { settings: { ...defaultAdversumSettings, logoDevToken: "pk_x" }, loaded: true };
  mocks.getCustomers.mockResolvedValue([
    { id: 7, name: "DUSW", color: "#112233" },
    { id: 8, name: "Herosmile", color: null, "color-safe": "#abcdef" },
    { id: 9, name: "Plain", color: null },
  ]);
  mocks.getProjects.mockResolvedValue([
    { id: 12, name: "Retainer", customer: 7 },
    { id: 13, name: "Website", customer: 8 },
    { id: 14, name: "Other", customer: 9 },
    { id: 15, name: "Orphan", customer: 404 },
  ]);
  mocks.useCustomerLogos.mockReturnValue({
    entries: new Map([
      [7, { customerId: 7, source: "homepage", dataUrl: "data:image/png;base64,AAAA" }],
      [8, { customerId: 8, source: "none", dataUrl: null }],
    ]),
  });
});
afterEach(() => {
  cleanup();
  setAdversumDisplay(null);
});

describe("AdversumBridge", () => {
  it("publishes customers by project and their logos, and clears on unmount", async () => {
    const { container, unmount } = render(<AdversumBridge windowLabel="tray-popup" />, { wrapper });
    expect(container.innerHTML).toBe("");
    await waitFor(() => expect(getAdversumDisplay()?.customersByProject.size).toBe(3));
    const display = getAdversumDisplay()!;
    expect(display.indicator).toBe("logo");
    expect(display.customersByProject.get(12)).toEqual({ id: 7, name: "DUSW", color: "#112233" });
    expect(display.customersByProject.get(13)?.color).toBe("#abcdef");
    expect(display.customersByProject.get(14)?.color).toBe("");
    expect(display.customersByProject.has(15)).toBe(false);
    expect([...display.logos]).toEqual([[7, "data:image/png;base64,AAAA"]]);
    expect(mocks.useCustomerLogos).toHaveBeenLastCalledWith({
      client: mocks.kimai.client,
      connectionId: "conn",
      customerIds: [7, 8, 9],
      logoDevToken: "pk_x",
      autoFetch: true,
    });
    unmount();
    expect(getAdversumDisplay()).toBeNull();
  });

  it("only fetches logos from the tray window and only in logo mode", async () => {
    const first = render(<AdversumBridge windowLabel="timer-reminder" />, { wrapper });
    await waitFor(() => expect(getAdversumDisplay()).not.toBeNull());
    expect(mocks.useCustomerLogos.mock.lastCall![0].autoFetch).toBe(false);
    first.unmount();

    mocks.settings = {
      settings: { ...defaultAdversumSettings, customerIndicator: "dots" },
      loaded: true,
    };
    render(<AdversumBridge windowLabel="tray-popup" />, { wrapper });
    await waitFor(() => expect(getAdversumDisplay()?.indicator).toBe("dots"));
    expect(mocks.useCustomerLogos.mock.lastCall![0].autoFetch).toBe(false);
  });

  it("waits for the fork settings and for a configured connection", async () => {
    mocks.settings = { settings: defaultAdversumSettings, loaded: false };
    mocks.kimai = { client: null, isConfigured: false, activeConnectionId: "" };
    const { rerender } = render(<AdversumBridge windowLabel="tray-popup" />, { wrapper });
    await Promise.resolve();
    expect(getAdversumDisplay()).toBeNull();
    expect(mocks.getProjects).not.toHaveBeenCalled();

    mocks.settings = { settings: defaultAdversumSettings, loaded: true };
    rerender(<AdversumBridge windowLabel="tray-popup" />);
    await waitFor(() => expect(getAdversumDisplay()).not.toBeNull());
    expect(getAdversumDisplay()!.customersByProject.size).toBe(0);
    expect(mocks.getCustomers).not.toHaveBeenCalled();
  });
});
