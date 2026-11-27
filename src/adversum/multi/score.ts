import { clockText } from "./format";
import type { Amount, MultiDraft } from "./types";

/**
 * A short way to write what was understood, for comparing readings of a
 * sentence: "60" minutes, "3x10" counted, "?x5" counted without a number,
 * "9:00-10:30" a time span, "rest", "?" nothing said.
 */
export function amountSignature(amount: Amount): string {
  switch (amount.kind) {
    case "minutes":
      return String(amount.minutes);
    case "times":
      return `${amount.count ?? "?"}x${amount.each ?? "?"}`;
    case "span":
      return `${clockText(amount.begin).padStart(5, "0")}-${clockText(amount.end).padStart(5, "0")}`;
    case "rest":
      return "rest";
    case "unknown":
      return "?";
  }
}

/** The activities of a draft as "customer amount", breaks left out. */
export function draftSignature(draft: MultiDraft | null): string[] {
  if (!draft) return [];
  return draft.items
    .filter((item) => !item.gap)
    .map((item) => {
      const customer = item.suggestions[0]?.combination.customer.split(" ")[0] ?? "–";
      return `${customer} ${amountSignature(item.amount)}`;
    });
}

/** Whether a reading has the expected customers and amounts, in order. */
export function matchesExpectation(
  signature: readonly string[],
  expected: readonly { customer: string; amount: readonly string[] }[],
): boolean {
  return (
    signature.length === expected.length &&
    expected.every(({ customer, amount }, index) =>
      amount.some((accepted) => signature[index] === `${customer} ${accepted}`),
    )
  );
}
