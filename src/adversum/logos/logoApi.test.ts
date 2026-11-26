import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import {
  clearManualLogo,
  fetchLogo,
  listLogos,
  LOGOS_CHANGED_EVENT,
  onLogoChange,
  setManualLogo,
} from "./logoApi";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.invoke.mockResolvedValue("result");
});

describe("logo commands", () => {
  it("passes each request to its native command", async () => {
    await expect(listLogos("conn")).resolves.toBe("result");
    expect(mocks.invoke).toHaveBeenLastCalledWith("adversum_logo_list", { connectionId: "conn" });

    const request = {
      connectionId: "conn",
      customerId: 7,
      homepage: "example.com",
      logoDevToken: null,
      force: true,
    };
    await fetchLogo(request);
    expect(mocks.invoke).toHaveBeenLastCalledWith("adversum_logo_fetch", { request });

    await setManualLogo("conn", 7, "QUJD");
    expect(mocks.invoke).toHaveBeenLastCalledWith("adversum_logo_set_manual", {
      request: { connectionId: "conn", customerId: 7, imageBase64: "QUJD" },
    });

    await clearManualLogo("conn", 7);
    expect(mocks.invoke).toHaveBeenLastCalledWith("adversum_logo_clear_manual", {
      request: { connectionId: "conn", customerId: 7 },
    });
  });

  it("forwards logo change events", async () => {
    const unlisten = vi.fn();
    mocks.listen.mockResolvedValue(unlisten);
    const callback = vi.fn();
    await expect(onLogoChange(callback)).resolves.toBe(unlisten);
    const [event, handler] = mocks.listen.mock.calls[0]!;
    expect(event).toBe(LOGOS_CHANGED_EVENT);
    const change = { connectionId: "conn", customerId: 7, entry: null };
    handler({ payload: change });
    expect(callback).toHaveBeenCalledWith(change);
  });
});
