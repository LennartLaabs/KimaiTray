// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import CustomerAvatar from "./CustomerAvatar";

afterEach(cleanup);

describe("CustomerAvatar", () => {
  it("shows the logo image at the requested size", () => {
    const { container } = render(
      <CustomerAvatar name="DUSW" color="#112233" logo="data:image/png;base64,AAAA" size={20} />,
    );
    const avatar = container.querySelector<HTMLElement>("[data-customer-avatar]")!;
    expect(avatar.style.width).toBe("20px");
    expect(avatar.style.height).toBe("20px");
    expect(avatar.title).toBe("DUSW");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(container.querySelector("[data-activity-dot]")).toBeNull();
  });

  it("falls back to initials on the customer color", () => {
    const { container } = render(
      <CustomerAvatar name="DUSW Unternehmensgruppe" color="#ffffff" size={28} />,
    );
    const initials = container.querySelector<HTMLElement>("[aria-hidden='true']")!;
    expect(initials.textContent).toBe("DU");
    expect(initials.style.backgroundColor).toBe("rgb(255, 255, 255)");
    expect(initials.style.color).toBe("rgb(17, 24, 39)");
    expect(initials.style.fontSize).toBe("11px");
    expect(container.querySelector("img")).toBeNull();
  });

  it("draws the activity color as a dot and pulses for running timers", () => {
    const { container, rerender } = render(
      <CustomerAvatar name="" color="" size={20} dotColor="#10b981" pulse />,
    );
    const avatar = container.querySelector<HTMLElement>("[data-customer-avatar]")!;
    expect(avatar.hasAttribute("title")).toBe(false);
    expect(avatar.textContent).toBe("");
    const dot = container.querySelector<HTMLElement>("[data-activity-dot]")!;
    expect(dot.style.backgroundColor).toBe("rgb(16, 185, 129)");
    expect(dot.style.width).toBe("6px");
    expect(dot.className).toContain("animate-pulse");

    rerender(<CustomerAvatar name="" color="" size={28} dotColor="#10b981" />);
    const still = container.querySelector<HTMLElement>("[data-activity-dot]")!;
    expect(still.style.width).toBe("9px");
    expect(still.className).not.toContain("animate-pulse");
  });
});
