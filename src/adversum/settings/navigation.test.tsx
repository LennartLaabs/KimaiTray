// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./CustomerLogosSection", () => ({ default: () => <div>logos-page</div> }));
vi.mock("./QuickEntrySection", () => ({ default: () => <div>quick-page</div> }));

import { ADVERSUM_NAV, renderAdversumSection } from "./navigation";

afterEach(cleanup);

describe("fork settings navigation", () => {
  it("describes every page of its sidebar group", () => {
    expect(ADVERSUM_NAV.group.titleKey).toBe("adversum.settingsGroup");
    for (const section of ADVERSUM_NAV.group.items) {
      expect(ADVERSUM_NAV.labelKeys[section]).toMatch(/^adversum\./);
      expect(ADVERSUM_NAV.icons[section]).toBeTruthy();
    }
  });

  it("renders a page inside the app's query client", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        {renderAdversumSection("adversumLogos")}
        {renderAdversumSection("adversumQuick")}
      </QueryClientProvider>,
    );
    expect(screen.getByText("logos-page")).toBeTruthy();
    expect(screen.getByText("quick-page")).toBeTruthy();
  });

  it("renders nothing where no query client exists", () => {
    const { container } = render(
      <>
        {renderAdversumSection("adversumLogos")}
        {renderAdversumSection("adversumQuick")}
      </>,
    );
    expect(container.innerHTML).toBe("");
  });
});
