import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildCatalog } from "../quickEntry/catalog";
import { EMPTY_HISTORY } from "../quickEntry/history";
import { parseQuickEntry, type QuickSuggestion } from "../quickEntry/parse";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { aliasesToLearn, resemblance, withoutLearned } from "./learn";
import { buildVocabulary } from "./vocabulary";
import {
  cancelVoice,
  cancelVoiceDownload,
  chooseVoiceModelDir,
  deleteVoiceModel,
  downloadVoiceModel,
  finishVoice,
  finishVoiceTest,
  getVoiceDevices,
  getVoiceStatus,
  learnAlias,
  openVoicePrivacySettings,
  requestVoicePermission,
  setVoiceVocabulary,
  startVoice,
  startVoiceTest,
} from "./voiceApi";

const now = new Date(2026, 10, 26, 14, 20);
const customers = [
  { id: 1, name: "DUSW" },
  { id: 2, name: "SolarTech NRW" },
  { id: 3, name: "K&K Global Solutions" },
  { id: 4, name: "Solar Team" },
];
const projects = [
  { id: 11, name: "Retainer", customer: 1 },
  { id: 21, name: "Imagefilm", customer: 2 },
  { id: 31, name: "Messeauftritt", customer: 3 },
  { id: 41, name: "Kampagne", customer: 4 },
];
const activities = [
  { id: 1, name: "Projektmanagement", project: null },
  { id: 2, name: "Design", project: null },
  { id: 3, name: "Austausch", project: null },
];
const aliases = {
  customers: { "3": ["kk", "K und K"] },
  projects: {},
  activities: { "1": ["pm", "PM"] },
};
const catalog = buildCatalog(customers, projects, activities, aliases);

function combination(key: string) {
  return catalog.combinations.find((item) => item.key === key)!;
}

/** The first spoken-mode suggestion for a sentence. */
function proposal(sentence: string): QuickSuggestion {
  return parseQuickEntry(sentence, catalog, EMPTY_HISTORY, now, {}).suggestions[0]!;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.invoke.mockResolvedValue(undefined);
});

describe("buildVocabulary", () => {
  it("lists projects, activities, aliases and customers, each once", () => {
    expect(buildVocabulary(catalog, aliases)).toBe(
      "Projekte: Retainer, Imagefilm, Messeauftritt, Kampagne. " +
        "Tätigkeiten: Projektmanagement, Design, Austausch. " +
        "Kürzel: pm, kk, K und K. " +
        "Kunden: DUSW, SolarTech NRW, K&K Global Solutions, Solar Team.",
    );
  });

  it("puts recurring names from past notes first, where they are cut first", () => {
    expect(buildVocabulary(catalog, undefined, ["Gigi", "Patrick", "gigi"])).toMatch(
      /^Notizen: Gigi, Patrick\. Projekte: /,
    );
  });

  it("leaves out empty groups and is empty without a catalog", () => {
    expect(buildVocabulary(catalog, undefined)).not.toContain("Kürzel");
    expect(buildVocabulary(buildCatalog([], [], []), aliases)).toBe("");
  });
});

describe("aliasesToLearn", () => {
  it("learns the word that named the wrong customer", () => {
    // "soltim" was taken for the customer "Solar Team"; SolarTech NRW was meant.
    const misnamed: QuickSuggestion = {
      ...proposal("Solar Team Design"),
      words: { customer: ["soltim"], project: [], activity: ["design"] },
    };
    expect(
      aliasesToLearn({
        spoken: "soltim Design",
        proposed: misnamed,
        chosen: combination("21-2"),
        catalog,
      }),
    ).toEqual([
      { kind: "customers", entityId: 2, alias: "soltim", name: "SolarTech NRW" },
    ]);
  });

  it("learns a leftover word that resembles the chosen name", () => {
    const proposed = proposal("solatek design angebot");
    expect(
      aliasesToLearn({
        spoken: "solatek Design Angebot seit 10 Uhr",
        proposed,
        chosen: combination("21-2"),
        catalog,
      }),
    ).toEqual([{ kind: "customers", entityId: 2, alias: "solatek", name: "SolarTech NRW" }]);
    // Of two candidates the closer one wins.
    expect(
      aliasesToLearn({
        spoken: "soltek solatek Design",
        proposed: null,
        chosen: combination("21-2"),
        catalog,
      }),
    ).toEqual([{ kind: "customers", entityId: 2, alias: "solatek", name: "SolarTech NRW" }]);
  });

  it("learns the only leftover word for the customer, by its sound or not at all alike", () => {
    expect(
      aliasesToLearn({
        spoken: "Kaka Design",
        proposed: proposal("Kaka Design"),
        chosen: combination("31-2"),
        catalog,
      }),
    ).toEqual([{ kind: "customers", entityId: 3, alias: "kaka", name: "K&K Global Solutions" }]);
    expect(
      aliasesToLearn({
        spoken: "Düsseldorfer pm",
        proposed: null,
        chosen: combination("11-1"),
        catalog,
      }),
    ).toEqual([{ kind: "customers", entityId: 1, alias: "duesseldorfer", name: "DUSW" }]);
  });

  it("learns nothing when the words already name what was chosen", () => {
    expect(
      aliasesToLearn({
        spoken: "DUSW Retainer Design",
        proposed: proposal("DUSW Retainer Projektmanagement"),
        chosen: combination("11-2"),
        catalog,
      }),
    ).toEqual([]);
  });

  it("does not guess an activity from a note word, nor from several words", () => {
    // Only the activity was changed; "Angebot" is a note.
    expect(
      aliasesToLearn({
        spoken: "DUSW Angebot",
        proposed: proposal("DUSW Angebot"),
        chosen: combination("11-3"),
        catalog,
      }),
    ).toEqual([]);
    // Two leftover words, neither like the customer's name.
    expect(
      aliasesToLearn({
        spoken: "Angebot schreiben Design",
        proposed: proposal("Angebot schreiben Design"),
        chosen: combination("31-2"),
        catalog,
      }),
    ).toEqual([]);
  });

  it("never takes the exact name of something else, short words or times", () => {
    // "Design" is an activity of its own and cannot become an alias for another.
    const proposed: QuickSuggestion = {
      ...proposal("DUSW Design"),
      words: { customer: ["dusw"], project: [], activity: ["design"] },
    };
    expect(
      aliasesToLearn({ spoken: "DUSW Design", proposed, chosen: combination("11-3"), catalog }),
    ).toEqual([]);
    expect(
      aliasesToLearn({
        spoken: "ab von 10 bis 11 Uhr mit dem pm",
        proposed: null,
        chosen: combination("11-1"),
        catalog,
      }),
    ).toEqual([]);
  });

  it("uses a word only once, customer first", () => {
    const learned = aliasesToLearn({
      spoken: "Messestand",
      proposed: null,
      chosen: combination("31-2"),
      catalog,
    });
    // "messestand" resembles the project "Messeauftritt" too, but the
    // customer comes first and takes the only word.
    expect(learned).toEqual([
      { kind: "customers", entityId: 3, alias: "messestand", name: "K&K Global Solutions" },
    ]);
  });
});

describe("resemblance", () => {
  const solartech = catalog.customers.get(2)!;
  const kk = catalog.customers.get(3)!;

  it("rates spelling and sound", () => {
    expect(resemblance("solartech", solartech)).toBe(1);
    expect(resemblance("solatek", solartech)).toBeGreaterThanOrEqual(0.5);
    expect(resemblance("buchhaltung", solartech)).toBeLessThan(0.5);
    // Same consonants as the acronym "kkgs".
    expect(resemblance("kakages", kk)).toBe(0.8);
    expect(resemblance("ae", kk)).toBeLessThan(0.5);
  });
});

describe("withoutLearned", () => {
  it("drops learned words from the note", () => {
    const learned = [{ kind: "customers" as const, entityId: 3, alias: "kaka", name: "K&K" }];
    expect(withoutLearned("Kaka Standbau planen", learned)).toBe("Standbau planen");
    expect(withoutLearned("Standbau", learned)).toBe("Standbau");
    expect(withoutLearned("Kaka", learned)).toBe("");
    expect(withoutLearned("Kaka Design", [])).toBe("Kaka Design");
  });
});

describe("voiceApi", () => {
  it("calls the native commands", async () => {
    await getVoiceStatus();
    await downloadVoiceModel("small");
    await cancelVoiceDownload();
    await deleteVoiceModel("base");
    await chooseVoiceModelDir();
    await requestVoicePermission();
    await openVoicePrivacySettings();
    await startVoice();
    await finishVoice();
    await cancelVoice();
    await setVoiceVocabulary("Kunden: DUSW.");
    await learnAlias("conn", "customers", 3, "kaka");
    await getVoiceDevices();
    await startVoiceTest();
    await finishVoiceTest();
    expect(mocks.invoke.mock.calls.slice(-3)).toEqual([
      ["adversum_voice_devices"],
      ["adversum_voice_test_start"],
      ["adversum_voice_test_finish"],
    ]);
    expect(mocks.invoke.mock.calls.slice(0, -3)).toEqual([
      ["adversum_voice_status"],
      ["adversum_voice_download", { model: "small" }],
      ["adversum_voice_cancel_download"],
      ["adversum_voice_delete_model", { model: "base" }],
      ["adversum_voice_choose_dir"],
      ["adversum_voice_request_permission"],
      ["adversum_voice_open_privacy"],
      ["adversum_voice_start"],
      ["adversum_voice_finish"],
      ["adversum_voice_cancel"],
      ["adversum_voice_set_vocabulary", { vocabulary: "Kunden: DUSW." }],
      [
        "adversum_learn_alias",
        { connectionId: "conn", kind: "customers", entityId: 3, alias: "kaka" },
      ],
    ]);
  });
});
