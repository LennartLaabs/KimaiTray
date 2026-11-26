// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAdversumSettings } from "./adversumSettings";
import type { LogoEntry } from "../logos/logoApi";

const mocks = vi.hoisted(() => ({
  kimai: { client: {} as unknown, isConfigured: true, activeConnectionId: "conn" },
  settings: { settings: {} as unknown, update: vi.fn() },
  getCustomers: vi.fn(),
  logos: { entries: new Map<number, unknown>(), reload: vi.fn(), apply: vi.fn() },
  useCustomerLogos: vi.fn(),
  setManualLogo: vi.fn(),
  clearManualLogo: vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { customer?: string }) =>
      options?.customer ? `${key}:${options.customer}` : key,
  }),
}));
vi.mock("../../hooks/useKimaiClient", () => ({ useKimaiClient: () => mocks.kimai }));
vi.mock("./useAdversumSettings", () => ({ useAdversumSettings: () => mocks.settings }));
vi.mock("../../api/projectApi", () => ({ getCustomers: mocks.getCustomers }));
vi.mock("../logos/useCustomerLogos", () => ({ useCustomerLogos: mocks.useCustomerLogos }));
vi.mock("../logos/logoApi", () => ({
  setManualLogo: mocks.setManualLogo,
  clearManualLogo: mocks.clearManualLogo,
}));
vi.mock("../../platform", () => ({ currentPlatform: () => ({ os: "macos" }) }));

import CustomerLogosSection from "./CustomerLogosSection";
import { LogoFileError } from "../logos/encodeImage";

function entry(customerId: number, source: LogoEntry["source"]): LogoEntry {
  return {
    customerId,
    source,
    dataUrl: source === "none" ? null : `data:image/png;base64,${customerId}`,
    stale: false,
    triedLogoDev: false,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const encodeImage = vi.fn();
const png = new File(["x"], "logo.png", { type: "image/png" });

function row(customerId: number) {
  return within(screen.getByTestId(`customer-logo-${customerId}`));
}

async function renderSection() {
  render(<CustomerLogosSection encodeImage={encodeImage} />, { wrapper });
  await waitFor(() => expect(screen.getByTestId("customer-logo-7")).toBeTruthy());
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.kimai = {
    client: { connectionId: "conn", cacheScope: "conn:1" },
    isConfigured: true,
    activeConnectionId: "conn",
  };
  mocks.settings = { settings: { ...defaultAdversumSettings }, update: vi.fn() };
  mocks.getCustomers.mockResolvedValue([
    { id: 8, name: "Herosmile", color: null, "color-safe": "#abcdef" },
    { id: 7, name: "DUSW", color: "#112233" },
    { id: 9, name: "Zeta", color: null },
  ]);
  mocks.logos = {
    entries: new Map([[7, entry(7, "manual")], [8, entry(8, "none")]]),
    reload: vi.fn().mockResolvedValue(undefined),
    apply: vi.fn(),
  };
  mocks.useCustomerLogos.mockImplementation(() => mocks.logos);
  encodeImage.mockResolvedValue("QUJD");
  mocks.setManualLogo.mockResolvedValue(entry(8, "manual"));
  mocks.clearManualLogo.mockResolvedValue(null);
});
afterEach(cleanup);

describe("CustomerLogosSection", () => {
  it("lists customers by name with their logo source", async () => {
    await renderSection();
    const names = screen.getAllByTestId(/^customer-logo-/).map((item) => item.dataset.testid);
    expect(names).toEqual(["customer-logo-7", "customer-logo-8", "customer-logo-9"]);
    expect(row(7).getByText("adversum.logos.source.manual")).toBeTruthy();
    expect(row(8).getByText("adversum.logos.source.none")).toBeTruthy();
    expect(row(9).getByText("adversum.logos.source.pending")).toBeTruthy();
    expect(row(7).getByText("adversum.logos.reset")).toBeTruthy();
    expect(row(8).queryByText("adversum.logos.reset")).toBeNull();
    expect(mocks.useCustomerLogos).toHaveBeenLastCalledWith({
      client: mocks.kimai.client,
      connectionId: "conn",
      customerIds: [7, 8, 9],
      logoDevToken: "",
      autoFetch: false,
    });
  });

  it("switches the customer indicator", async () => {
    await renderSection();
    fireEvent.click(screen.getByText("adversum.logos.indicatorDots"));
    expect(mocks.settings.update).toHaveBeenCalledWith("customerIndicator", "dots");
  });

  it("saves the logo.dev key only on request", async () => {
    await renderSection();
    const save = screen.getByText("common.save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("pk_…"), { target: { value: " pk_live " } });
    expect(mocks.settings.update).not.toHaveBeenCalled();
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(mocks.settings.update).toHaveBeenCalledWith("logoDevToken", "pk_live");
  });

  it("sets a manual logo from a chosen file", async () => {
    await renderSection();
    const input = screen.getByLabelText("adversum.logos.chooseFor:Herosmile") as HTMLInputElement;
    const click = vi.spyOn(input, "click").mockImplementation(() => undefined);
    fireEvent.click(row(8).getByText("adversum.logos.choose"));
    expect(click).toHaveBeenCalled();

    fireEvent.change(input, { target: { files: [png] } });
    await waitFor(() => expect(mocks.logos.apply).toHaveBeenCalledWith(8, entry(8, "manual")));
    expect(encodeImage).toHaveBeenCalledWith(png);
    expect(mocks.setManualLogo).toHaveBeenCalledWith("conn", 8, "QUJD");

    fireEvent.change(input, { target: { files: [] } });
    expect(encodeImage).toHaveBeenCalledTimes(1);
  });

  it("sets a manual logo from a dropped file and marks the drop target", async () => {
    await renderSection();
    const target = screen.getByTestId("customer-logo-9");
    fireEvent.dragEnter(target);
    expect(target.className).toContain("bg-[var(--accent-soft)]");
    fireEvent.dragLeave(target);
    expect(target.className).not.toContain("bg-[var(--accent-soft)]");
    fireEvent.dragOver(target);
    fireEvent.drop(target, { dataTransfer: { files: [png] } });
    expect(target.className).not.toContain("bg-[var(--accent-soft)]");
    await waitFor(() => expect(mocks.setManualLogo).toHaveBeenCalledWith("conn", 9, "QUJD"));
  });

  it("ignores a drop while the customer is busy", async () => {
    let finish: (value: string) => void = () => undefined;
    encodeImage.mockReturnValue(new Promise<string>((resolve) => { finish = resolve; }));
    await renderSection();
    const target = screen.getByTestId("customer-logo-9");
    fireEvent.drop(target, { dataTransfer: { files: [png] } });
    await waitFor(() =>
      expect((row(9).getByText("adversum.logos.choose") as HTMLButtonElement).disabled).toBe(true),
    );
    fireEvent.drop(target, { dataTransfer: { files: [png] } });
    expect(encodeImage).toHaveBeenCalledTimes(1);
    await act(async () => finish("QUJD"));
  });

  it("explains why an image could not be used", async () => {
    await renderSection();
    const input = screen.getByLabelText("adversum.logos.chooseFor:Zeta");
    encodeImage.mockRejectedValueOnce(new LogoFileError("tooLarge"));
    fireEvent.change(input, { target: { files: [png] } });
    await waitFor(() => expect(row(9).getByText("adversum.logos.tooLarge")).toBeTruthy());

    encodeImage.mockRejectedValueOnce(new LogoFileError("unreadable"));
    fireEvent.change(input, { target: { files: [png] } });
    await waitFor(() => expect(row(9).getByText("adversum.logos.failed")).toBeTruthy());
    expect(row(8).queryByText("adversum.logos.failed")).toBeNull();
  });

  it("resets a manual logo and reloads a fetched one", async () => {
    await renderSection();
    fireEvent.click(row(7).getByText("adversum.logos.reset"));
    await waitFor(() => expect(mocks.logos.apply).toHaveBeenCalledWith(7, null));
    expect(mocks.clearManualLogo).toHaveBeenCalledWith("conn", 7);

    fireEvent.click(row(8).getByText("adversum.logos.reload"));
    await waitFor(() => expect(mocks.logos.reload).toHaveBeenCalledWith(8));
  });

  it("reloads every logo that was not set by hand", async () => {
    mocks.logos.reload.mockImplementation(async (customerId: number) => {
      if (customerId === 8) throw new Error("offline");
    });
    await renderSection();
    const reloadAll = screen.getByText("adversum.logos.reloadAll").closest("[data-settings-item]")!;
    fireEvent.click(within(reloadAll as HTMLElement).getByRole("button"));
    await waitFor(() => expect(mocks.logos.reload).toHaveBeenCalledTimes(2));
    expect(mocks.logos.reload.mock.calls.map(([id]) => id)).toEqual([8, 9]);
    await waitFor(() => expect(row(8).getByText("adversum.logos.failed")).toBeTruthy());
    await waitFor(() =>
      expect((within(reloadAll as HTMLElement).getByRole("button") as HTMLButtonElement).disabled)
        .toBe(false),
    );
  });

  it("shows a note instead of the list without connection, while loading and when empty", async () => {
    mocks.kimai = { client: null, isConfigured: false, activeConnectionId: "" };
    const first = render(<CustomerLogosSection />, { wrapper });
    expect(screen.getByText("adversum.logos.noConnection")).toBeTruthy();
    expect(mocks.getCustomers).not.toHaveBeenCalled();
    first.unmount();

    mocks.kimai = {
      client: { connectionId: "conn", cacheScope: "conn:2" },
      isConfigured: true,
      activeConnectionId: "conn",
    };
    mocks.getCustomers.mockResolvedValue([]);
    render(<CustomerLogosSection />, { wrapper });
    expect(screen.getByText("common.loading")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("adversum.logos.empty")).toBeTruthy());
  });
});
