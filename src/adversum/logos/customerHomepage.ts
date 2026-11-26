import type { KimaiClient } from "../../api/kimaiClient";

/**
 * Kimai only returns a customer's `homepage` from the detail endpoint
 * (`GET /api/customers/{id}`), not from the customer list. A missing field, an
 * empty value or a failed request all mean "no homepage".
 */
export async function getCustomerHomepage(
  client: KimaiClient,
  customerId: number,
): Promise<string | null> {
  try {
    const customer = await client.get<unknown>(`/api/customers/${customerId}`);
    const homepage =
      customer && typeof customer === "object"
        ? (customer as { homepage?: unknown }).homepage
        : undefined;
    return typeof homepage === "string" && homepage.trim() ? homepage.trim() : null;
  } catch {
    return null;
  }
}
