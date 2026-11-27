// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KimaiClient } from "../../api/kimaiClient";
import { buildCatalog } from "../quickEntry/catalog";
import type { HistoryEntry } from "../quickEntry/history";

const mocks = vi.hoisted(() => ({
  getByLabel: vi.fn(),
  saveProfile: vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      options ? `${key}:${Object.values(options).join(",")}` : key,
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({ Window: { getByLabel: mocks.getByLabel } }));
vi.mock("./profileApi", async (original) => ({
  ...(await original<typeof import("./profileApi")>()),
  saveProfile: mocks.saveProfile,
}));

import ProfileHints, { PROFILE_SETUP_EVENT } from "./ProfileHints";

const client = {} as KimaiClient;
const customers = [
  { id: 1, name: "DUSW" },
  { id: 2, name: "Bäckerei Huber" },
];
const catalog = buildCatalog(
  customers.map((customer) => ({ ...customer, comment: null })),
  [
    { id: 11, name: "Retainer", customer: 1 },
    { id: 21, name: "Website", customer: 2 },
  ],
  [{ id: 4, name: "Design", project: null }],
);
const recent = (description: string): HistoryEntry[] =>
  [1, 2, 3].map((days) => ({
    projectId: 21,
    activityId: 4,
    begin: new Date(Date.now() - days * 86_400_000),
    description,
  }));

function show(props: { customers?: typeof customers; entries?: HistoryEntry[] } = {}) {
  return render(
    <ProfileHints
      client={client}
      connectionId="conn"
      customers={props.customers ?? customers}
      entries={props.entries ?? []}
      catalog={catalog}
    />,
  );
}

const settings = { show: vi.fn(), setFocus: vi.fn(), emitTo: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.getByLabel.mockResolvedValue(settings);
  mocks.saveProfile.mockResolvedValue("");
});
afterEach(cleanup);

describe("the hint line for profiles", () => {
  it("is quiet when everything is known", () => {
    const { container } = show();
    expect(container.innerHTML).toBe("");
    // The customers of the first comparison are known from then on.
    expect(JSON.parse(localStorage.getItem("adversum-known-customers:conn")!)).toEqual({
      known: [1, 2],
      pending: [],
    });
    cleanup();
    // While the list is still loading, nothing is compared.
    localStorage.clear();
    show({ customers: [] });
    expect(localStorage.getItem("adversum-known-customers:conn")).toBeNull();
  });

  it("points out a customer that is new in Kimai and leads to its profile", async () => {
    localStorage.setItem("adversum-known-customers:conn", JSON.stringify({ known: [1], pending: [] }));
    const { container } = show();
    expect(container.querySelector("[data-profile-hint='new']")!.textContent).toContain(
      "adversum.profile.hint.newCustomer:Bäckerei Huber",
    );
    fireEvent.click(screen.getByText("adversum.profile.hint.setUp"));
    await waitFor(() =>
      expect(settings.emitTo).toHaveBeenCalledWith("settings", PROFILE_SETUP_EVENT, { customerId: 2 }),
    );
    expect(settings.emitTo).toHaveBeenCalledWith("settings", "kimai://navigate-section", "adversumQuick");
    expect(settings.show).toHaveBeenCalledTimes(1);
    expect(container.innerHTML).toBe("");
    expect(JSON.parse(localStorage.getItem("adversum-known-customers:conn")!).pending).toEqual([]);
  });

  it("can be put off, and survives a settings window that is not there", async () => {
    localStorage.setItem("adversum-known-customers:conn", JSON.stringify({ known: [], pending: [] }));
    const { container } = show();
    expect(container.textContent).toContain("newCustomer:DUSW");
    fireEvent.click(screen.getByText("adversum.profile.hint.later"));
    expect(container.textContent).toContain("newCustomer:Bäckerei Huber");
    mocks.getByLabel.mockResolvedValue(null);
    fireEvent.click(screen.getByText("adversum.profile.hint.setUp"));
    await act(async () => undefined);
    expect(settings.show).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe("");
    // A window that fails to open is no reason to fail loudly.
    cleanup();
    localStorage.setItem("adversum-known-customers:conn", JSON.stringify({ known: [1], pending: [] }));
    mocks.getByLabel.mockRejectedValue(new Error("no windows"));
    show();
    fireEvent.click(screen.getByText("adversum.profile.hint.setUp"));
    await act(async () => undefined);
  });

  it("proposes once what keeps turning up in a customer's notes, and writes it on yes", async () => {
    const { container } = show({ entries: recent("Frau Maier Flyer") });
    expect(container.querySelector("[data-profile-hint='suggestion']")!.textContent).toContain(
      "adversum.profile.hint.add:Flyer,Bäckerei Huber",
    );
    fireEvent.click(screen.getByText("adversum.profile.hint.no"));
    expect(container.textContent).toContain("hint.add:Frau Maier,Bäckerei Huber");
    fireEvent.click(screen.getByText("adversum.profile.hint.yes"));
    await waitFor(() => expect(container.innerHTML).toBe(""));
    expect(mocks.saveProfile).toHaveBeenCalledWith(client, "customers", 2, {
      aliases: [],
      contacts: [{ name: "Frau Maier", variants: [] }],
      topics: [],
    });
    // Both answers are remembered: the next start asks nothing.
    cleanup();
    expect(show({ entries: recent("Frau Maier Flyer") }).container.innerHTML).toBe("");
  });

  it("says once when Kimai does not let the suggestion be written", async () => {
    mocks.saveProfile.mockRejectedValue("forbidden");
    localStorage.setItem("adversum-profile-answered:conn", "not json");
    const { container } = show({ entries: recent("Flyer") });
    fireEvent.click(screen.getByText("adversum.profile.hint.yes"));
    await waitFor(() =>
      expect(container.querySelector("[data-profile-hint='problem']")).not.toBeNull(),
    );
    fireEvent.click(screen.getByText("adversum.profile.hint.ok"));
    expect(container.innerHTML).toBe("");
  });
});
