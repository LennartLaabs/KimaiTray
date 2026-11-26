import type { KimaiClient } from "../../api/kimaiClient";

/** What Kimai says about a customer's homepage right now. */
export interface HomepageLookup {
  /** The homepage as stored in Kimai, trimmed; `null` when there is none. */
  homepage: string | null;
  /** The request to Kimai failed, so the homepage is unknown. */
  failed: boolean;
}

/**
 * Kimai only returns a customer's `homepage` from the detail endpoint
 * (`GET /api/customers/{id}`), not from the customer list. A missing field or
 * an empty value means "no homepage"; a failed request is reported as such,
 * because "unknown" must not be mistaken for "none".
 */
export async function lookupCustomerHomepage(
  client: KimaiClient,
  customerId: number,
): Promise<HomepageLookup> {
  try {
    const customer = await client.get<unknown>(`/api/customers/${customerId}`);
    const homepage =
      customer && typeof customer === "object"
        ? (customer as { homepage?: unknown }).homepage
        : undefined;
    return {
      homepage: typeof homepage === "string" && homepage.trim() ? homepage.trim() : null,
      failed: false,
    };
  } catch {
    return { homepage: null, failed: true };
  }
}
