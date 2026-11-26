import type { ReactElement } from "react";
import CustomerAvatar from "../logos/CustomerAvatar";
import { useAdversumDisplay } from "./displayStore";

export const LIST_AVATAR_SIZE = 20;
export const CARD_AVATAR_SIZE = 28;

interface CustomerIndicatorOptions {
  /** Kimai project of the task; without it the upstream dots are kept. */
  projectId?: number;
  /** "card" for the roomy timer cards, "list" everywhere else. */
  variant?: "list" | "card";
  /** Customer color of the task, used until the customer itself is known. */
  customerColor: string;
  /** Activity color, drawn as a dot on the avatar. */
  dotColor: string;
  pulse?: boolean;
}

/**
 * The customer avatar that replaces upstream's color dots, or `null` when the
 * dots should stay: outside the running app, in "dots" mode, or for a task
 * whose project is unknown.
 */
export function useCustomerIndicator({
  projectId,
  variant = "list",
  customerColor,
  dotColor,
  pulse,
}: CustomerIndicatorOptions): ReactElement | null {
  const display = useAdversumDisplay();
  if (!display || display.indicator !== "logo" || projectId == null) return null;
  const customer = display.customersByProject.get(projectId);
  return (
    <CustomerAvatar
      name={customer?.name ?? ""}
      color={customer?.color || customerColor}
      logo={customer ? display.logos.get(customer.id) : undefined}
      size={variant === "card" ? CARD_AVATAR_SIZE : LIST_AVATAR_SIZE}
      dotColor={dotColor}
      pulse={pulse}
    />
  );
}
