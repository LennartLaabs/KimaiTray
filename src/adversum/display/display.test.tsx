// @vitest-environment jsdom

import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAdversumDisplay,
  setAdversumDisplay,
  useAdversumDisplay,
  type AdversumDisplayState,
} from "./displayStore";
import {
  customerFirstTaskLabel,
  upstreamTaskLabel,
  useTaskLabel,
} from "./taskLabel";
import {
  CARD_AVATAR_SIZE,
  LIST_AVATAR_SIZE,
  useCustomerIndicator,
} from "./CustomerIndicator";
import ColorDots from "../../components/ColorDots";
import FavoriteTaskItem from "../../components/FavoriteTaskItem";
import RecentTaskItem from "../../components/RecentTaskItem";
import TodayEntryItem from "../../components/TodayEntryItem";
import PendingTimerCard from "../../components/PendingTimerCard";
import type { FavoriteTask, RecentTask, TodayEntry } from "../../types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const display: AdversumDisplayState = {
  indicator: "logo",
  customersByProject: new Map([
    [12, { id: 7, name: "DUSW Unternehmensgruppe", color: "#112233" }],
    [13, { id: 8, name: "Herosmile", color: "" }],
  ]),
  logos: new Map([[7, "data:image/png;base64,AAAA"]]),
};

const task = {
  project: "Marketing Retainer",
  activity: "Projektmanagement",
  customer: "DUSW Unternehmensgruppe",
  description: "Gigi Call",
};

afterEach(() => {
  cleanup();
  setAdversumDisplay(null);
});

describe("display store", () => {
  it("is empty until the bridge publishes and notifies subscribers", () => {
    const { result, unmount } = renderHook(() => useAdversumDisplay());
    expect(result.current).toBeNull();
    act(() => setAdversumDisplay(display));
    expect(result.current).toBe(display);
    expect(getAdversumDisplay()).toBe(display);
    act(() => setAdversumDisplay(display));
    expect(result.current).toBe(display);
    unmount();
    act(() => setAdversumDisplay(null));
    expect(getAdversumDisplay()).toBeNull();
  });
});

describe("task labels", () => {
  it("keeps upstream's layout outside the running app", () => {
    expect(upstreamTaskLabel(task)).toEqual({
      title: "Marketing Retainer",
      aside: "Projektmanagement",
      subtitle: "DUSW Unternehmensgruppe · Gigi Call",
      titleWeight: "font-medium",
    });
    expect(renderHook(() => useTaskLabel(task)).result.current.title).toBe("Marketing Retainer");
  });

  it("puts the customer first when the fork display is active", () => {
    expect(customerFirstTaskLabel(task)).toEqual({
      title: "DUSW Unternehmensgruppe",
      aside: "",
      subtitle: "Marketing Retainer · Projektmanagement · Gigi Call",
      titleWeight: "font-semibold",
    });
    expect(customerFirstTaskLabel({ ...task, description: "" }).subtitle).toBe(
      "Marketing Retainer · Projektmanagement",
    );
    expect(customerFirstTaskLabel({ ...task, customer: "" })).toEqual({
      title: "Marketing Retainer",
      aside: "",
      subtitle: "Projektmanagement · Gigi Call",
      titleWeight: "font-semibold",
    });
    setAdversumDisplay(display);
    expect(renderHook(() => useTaskLabel(task)).result.current.title).toBe(
      "DUSW Unternehmensgruppe",
    );
  });
});

describe("customer indicator", () => {
  const options = { projectId: 12, customerColor: "#445566", dotColor: "#10b981" };

  it("keeps the dots without display data, in dots mode and without a project", () => {
    expect(renderHook(() => useCustomerIndicator(options)).result.current).toBeNull();
    setAdversumDisplay({ ...display, indicator: "dots" });
    expect(renderHook(() => useCustomerIndicator(options)).result.current).toBeNull();
    setAdversumDisplay(display);
    expect(
      renderHook(() => useCustomerIndicator({ ...options, projectId: undefined })).result.current,
    ).toBeNull();
  });

  it("renders the logo for a known customer in list and card size", () => {
    setAdversumDisplay(display);
    const list = renderHook(() => useCustomerIndicator(options)).result.current!;
    expect(list.props).toMatchObject({
      name: "DUSW Unternehmensgruppe",
      color: "#112233",
      logo: "data:image/png;base64,AAAA",
      size: LIST_AVATAR_SIZE,
      dotColor: "#10b981",
    });
    const card = renderHook(() =>
      useCustomerIndicator({ ...options, variant: "card", pulse: true }),
    ).result.current!;
    expect(card.props).toMatchObject({ size: CARD_AVATAR_SIZE, pulse: true });
    expect(LIST_AVATAR_SIZE).toBe(20);
    expect(CARD_AVATAR_SIZE).toBe(28);
  });

  it("uses the task's customer color while the customer is unknown or colorless", () => {
    setAdversumDisplay(display);
    const colorless = renderHook(() =>
      useCustomerIndicator({ ...options, projectId: 13 }),
    ).result.current!;
    expect(colorless.props).toMatchObject({ name: "Herosmile", color: "#445566", logo: undefined });
    const unknown = renderHook(() =>
      useCustomerIndicator({ ...options, projectId: 99 }),
    ).result.current!;
    expect(unknown.props).toMatchObject({ name: "", color: "#445566", logo: undefined });
  });
});

describe("hooks in upstream components", () => {
  const colors = { activityColor: "#10b981", projectColor: "#222222", customerColor: "#445566" };
  const favorite: FavoriteTask = {
    key: "12-3", projectId: 12, activityId: 3, tags: [], ...task, ...colors,
  };
  const recent: RecentTask = { ...favorite, timesheetId: 99, lastUsed: "today" };
  const entry: TodayEntry = {
    id: 5, projectId: 12, activityId: 3, tags: [], ...task, ...colors,
    billable: false, beginIso: "2026-11-26T09:00:00+0100", endIso: "2026-11-26T10:00:00+0100",
    duration: 3600, isRunning: false,
  };

  it("ColorDots renders dots upstream and the avatar in logo mode", () => {
    const { container, rerender } = render(
      <ColorDots {...colors} colorMode="kimai" projectId={12} />,
    );
    expect(container.querySelector("[data-customer-avatar]")).toBeNull();
    act(() => setAdversumDisplay(display));
    rerender(<ColorDots {...colors} colorMode="kimai" projectId={12} variant="card" pulse />);
    const avatar = container.querySelector<HTMLElement>("[data-customer-avatar]")!;
    expect(avatar.style.width).toBe("28px");
    expect(container.querySelector<HTMLElement>("[data-activity-dot]")!.style.backgroundColor)
      .toBe("rgb(16, 185, 129)");
  });

  it("list entries show the customer first, with logo", () => {
    setAdversumDisplay(display);
    const noop = () => undefined;
    for (const element of [
      <FavoriteTaskItem key="f" task={favorite} onStart={noop} onRemove={noop} />,
      <RecentTaskItem key="r" task={recent} onStart={noop} onHide={noop} onDelete={noop} />,
      <TodayEntryItem key="t" entry={entry} />,
    ]) {
      const { container, getByText, unmount } = render(element);
      expect(getByText("DUSW Unternehmensgruppe").className).toContain("font-semibold");
      expect(getByText("Marketing Retainer · Projektmanagement · Gigi Call")).toBeTruthy();
      expect(container.querySelector("[data-customer-avatar] img")).not.toBeNull();
      unmount();
    }
  });

  it("list entries keep upstream's labels without the fork display", () => {
    const noop = () => undefined;
    const { getByText } = render(
      <RecentTaskItem task={recent} onStart={noop} onHide={noop} onDelete={noop} />,
    );
    expect(getByText("Marketing Retainer").className).toContain("font-medium");
    expect(getByText("Projektmanagement")).toBeTruthy();
    expect(getByText("DUSW Unternehmensgruppe · Gigi Call")).toBeTruthy();
  });

  it("the pending card shows the logo when the preview names a project", () => {
    setAdversumDisplay(display);
    const preview = { project: "Marketing Retainer", activity: "PM", ...colors, projectId: 12 };
    const { container, rerender } = render(<PendingTimerCard preview={preview} />);
    expect(container.querySelector<HTMLElement>("[data-customer-avatar]")!.style.width).toBe("28px");
    rerender(<PendingTimerCard preview={preview} compact />);
    expect(container.querySelector<HTMLElement>("[data-customer-avatar]")!.style.width).toBe("20px");
    rerender(<PendingTimerCard preview={{ ...preview, projectId: undefined }} compact />);
    expect(container.querySelector("[data-customer-avatar]")).toBeNull();
  });
});
