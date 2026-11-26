import { describe, expect, it, vi } from "vitest";
import type { KimaiClient } from "../../api/kimaiClient";
import { lookupCustomerHomepage } from "./customerHomepage";

function clientReturning(value: unknown): KimaiClient {
  return { get: vi.fn().mockResolvedValue(value) } as unknown as KimaiClient;
}

describe("lookupCustomerHomepage", () => {
  it("reads the homepage from the customer detail endpoint", async () => {
    const client = clientReturning({ id: 7, name: "DUSW", homepage: " https://dusw.de " });
    await expect(lookupCustomerHomepage(client, 7)).resolves.toEqual({
      homepage: "https://dusw.de",
      failed: false,
    });
    expect(client.get).toHaveBeenCalledWith("/api/customers/7");
  });

  it.each([
    ["a missing field", { id: 7 }],
    ["an empty value", { homepage: "   " }],
    ["a null value", { homepage: null }],
    ["a non-object response", "oops"],
    ["an empty response", null],
  ])("treats %s as no homepage", async (_label, response) => {
    await expect(lookupCustomerHomepage(clientReturning(response), 7)).resolves.toEqual({
      homepage: null,
      failed: false,
    });
  });

  it("reports a failed request instead of claiming there is no homepage", async () => {
    const client = { get: vi.fn().mockRejectedValue(new Error("403")) } as unknown as KimaiClient;
    await expect(lookupCustomerHomepage(client, 7)).resolves.toEqual({
      homepage: null,
      failed: true,
    });
  });
});
