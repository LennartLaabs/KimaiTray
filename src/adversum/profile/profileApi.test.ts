import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), emitTo: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: mocks.emitTo }));

import { KimaiApiError, type KimaiClient } from "../../api/kimaiClient";
import {
  loadEntity,
  parseProfileAnswer,
  PROFILE_INSTRUCTIONS,
  PROFILE_SCHEMA,
  PROFILES_CHANGED_EVENT,
  profileWords,
  readProfile,
  saveProfile,
} from "./profileApi";
import { EMPTY_PROFILE } from "./profileText";

const get = vi.fn();
const patch = vi.fn();
const client = { get, patch } as unknown as KimaiClient;
const profile = { aliases: ["Huber"], contacts: [{ name: "Sepp", variants: [] }], topics: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.emitTo.mockResolvedValue(undefined);
  patch.mockResolvedValue({});
});

describe("loadEntity", () => {
  it("reads what a profile needs", async () => {
    get.mockResolvedValue({
      id: 3,
      name: "Bäckerei Huber GmbH",
      comment: "Hinweis",
      contact: "Sepp Huber",
      homepage: " ",
      number: "K-003",
    });
    await expect(loadEntity(client, "customers", 3)).resolves.toEqual({
      name: "Bäckerei Huber GmbH",
      comment: "Hinweis",
      contact: "Sepp Huber",
      homepage: null,
    });
    expect(get).toHaveBeenCalledWith("/api/customers/3");
    get.mockResolvedValue({ id: 3 });
    await expect(loadEntity(client, "projects", 3)).rejects.toThrow("invalid entity");
    get.mockResolvedValue(null);
    await expect(loadEntity(client, "activities", 3)).rejects.toThrow("invalid entity");
  });
});

describe("saveProfile", () => {
  it("writes only the profile lines into the description as it is right now", async () => {
    get.mockResolvedValue({ name: "Huber", comment: "Rechnung per Post.\nAliasse: Alt" });
    await expect(saveProfile(client, "customers", 3, profile)).resolves.toBe(
      "Rechnung per Post.\n\nAliasse: Huber\nKontakte: Sepp",
    );
    expect(patch).toHaveBeenCalledWith("/api/customers/3", {
      comment: "Rechnung per Post.\n\nAliasse: Huber\nKontakte: Sepp",
    });
    // The other windows read Kimai's lists again.
    expect(mocks.emitTo.mock.calls).toEqual([
      ["tray-popup", PROFILES_CHANGED_EVENT, null],
      ["adversum-quick", PROFILES_CHANGED_EVENT, null],
    ]);
  });

  it("writes nothing when nothing changes, and survives windows that are not there", async () => {
    mocks.emitTo.mockRejectedValue(new Error("no window"));
    get.mockResolvedValue({ name: "Projekt", comment: null });
    await expect(saveProfile(client, "projects", 11, EMPTY_PROFILE)).resolves.toBe("");
    expect(patch).not.toHaveBeenCalled();
  });

  it("says when Kimai does not allow it, and when it fails otherwise", async () => {
    get.mockResolvedValue({ name: "Huber", comment: null });
    patch.mockRejectedValue(new KimaiApiError(403, "Forbidden", null, "forbidden"));
    await expect(saveProfile(client, "customers", 3, profile)).rejects.toBe("forbidden");
    patch.mockRejectedValue(new KimaiApiError(500, "Server Error", null, "server_error"));
    await expect(saveProfile(client, "customers", 3, profile)).rejects.toBe("failed");
    get.mockRejectedValue(new Error("offline"));
    await expect(saveProfile(client, "customers", 3, profile)).rejects.toBe("failed");
  });
});

describe("a sentence about a customer, with Claude Code's help", () => {
  const sentence = "Ansprechpartner Sepp Huber, genannt Seppi, wir machen Website und Google Ads";

  it("keeps only what is made of the sentence's words", () => {
    const answer = JSON.stringify({
      aliases: ["Huber", "Bäckerei"],
      contacts: [
        { name: "Sepp Huber", nicknames: ["Seppi", "Josef"] },
        { name: "Frau Maier", nicknames: [] },
        "Sepp",
        { name: 7 },
      ],
      topics: ["Website", "Google Ads", "SEO", 3],
    });
    expect(parseProfileAnswer(`\`\`\`json\n${answer}\n\`\`\``, sentence)).toEqual({
      aliases: ["Huber"],
      contacts: [{ name: "Sepp Huber", variants: ["Seppi"] }],
      topics: ["Website", "Google Ads"],
    });
    expect(parseProfileAnswer("{}", sentence)).toEqual(EMPTY_PROFILE);
    for (const wrong of ["keine Ahnung", "[]", "null", '"text"']) {
      expect(parseProfileAnswer(wrong, sentence)).toBeNull();
    }
  });

  it("adds what Claude Code found to what the rules found", async () => {
    mocks.invoke.mockResolvedValue(
      JSON.stringify({ aliases: [], contacts: [], topics: ["Google Ads", "Website"] }),
    );
    await expect(readProfile("Sepp Huber ist unser Mann dort, Website und Google Ads")).resolves.toEqual({
      ...EMPTY_PROFILE,
      topics: ["Google Ads", "Website"],
    });
    expect(mocks.invoke).toHaveBeenCalledWith("adversum_profile_extract", {
      sentence: "Sepp Huber ist unser Mann dort, Website und Google Ads",
      instructions: PROFILE_INSTRUCTIONS,
      schema: JSON.stringify(PROFILE_SCHEMA),
    });
  });

  it("is the rules' reading when Claude Code is not asked, fails or talks nonsense", async () => {
    const byRules = {
      aliases: [],
      contacts: [{ name: "Sepp Huber", variants: ["Seppi"] }],
      topics: ["Website", "Google Ads"],
    };
    mocks.invoke.mockResolvedValue(null);
    await expect(readProfile(sentence)).resolves.toEqual(byRules);
    mocks.invoke.mockRejectedValue(new Error("not the settings window"));
    await expect(readProfile(sentence)).resolves.toEqual(byRules);
    mocks.invoke.mockResolvedValue("Entschuldigung");
    await expect(readProfile(sentence)).resolves.toEqual(byRules);
  });
});

describe("profileWords", () => {
  it("lists every word of a profile, folded", () => {
    expect([
      ...profileWords({
        aliases: ["BH"],
        contacts: [{ name: "Frau Müller", variants: ["Mülli"] }],
        topics: ["Roll-Ups"],
      }),
    ]).toEqual(["bh", "frau", "mueller", "muelli", "roll", "ups"]);
  });
});
