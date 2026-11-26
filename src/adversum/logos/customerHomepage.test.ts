import { describe, expect, it, vi } from "vitest";
import type { KimaiClient } from "../../api/kimaiClient";
import { getCustomerHomepage } from "./customerHomepage";

function clientReturning(value: unknown): KimaiClient {
  return { get: vi.fn().mockResolvedValue(value) } as unknown as KimaiClient;
}

describe("getCustomerHomepage", () => {
  it("reads the homepage from the customer detail endpoint", async () => {
    const client = clientReturning({ id: 7, name: "DUSW", homepage: " https://dusw.example " });
    await expect(getCustomerHomepage(client, 7)).resolves.toBe("https://dusw.example");
    expect(client.get).toHaveBeenCalledWith("/api/customers/7");
  });

  it.each([
    ["a missing field", { id: 7 }],
    ["an empty value", { homepage: "   " }],
    ["a null value", { homepage: null }],
    ["a non-object response", "oops"],
    ["an empty response", null],
  ])("treats %s as no homepage", async (_label, response) => {
    await expect(getCustomerHomepage(clientReturning(response), 7)).resolves.toBeNull();
  });

  it("treats a failed request as no homepage", async () => {
    const client = { get: vi.fn().mockRejectedValue(new Error("403")) } as unknown as KimaiClient;
    await expect(getCustomerHomepage(client, 7)).resolves.toBeNull();
  });
});
