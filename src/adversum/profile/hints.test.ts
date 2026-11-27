import { describe, expect, it } from "vitest";
import { buildCatalog } from "../quickEntry/catalog";
import type { HistoryEntry } from "../quickEntry/history";
import { suggestFromNotes, trackCustomers, withSuggestion, withVariant } from "./hints";
import { EMPTY_PROFILE } from "./profileText";

/** Thursday 26 November 2026, 14:20. */
const now = new Date(2026, 10, 26, 14, 20);

describe("trackCustomers", () => {
  it("knows everybody on the first comparison", () => {
    expect(trackCustomers(null, [1, 2, 3])).toEqual({ known: [1, 2, 3], pending: [] });
  });

  it("puts a customer that is new in Kimai on the list, once", () => {
    const first = trackCustomers({ known: [1, 2], pending: [] }, [1, 2, 7]);
    expect(first).toEqual({ known: [1, 2, 7], pending: [7] });
    expect(trackCustomers(first, [1, 2, 7])).toEqual(first);
    // Looked at (taken off the list by the hint): it does not come back.
    expect(trackCustomers({ known: [1, 2, 7], pending: [] }, [1, 2, 7]).pending).toEqual([]);
    // A customer that left Kimai needs no profile.
    expect(trackCustomers(first, [1, 2])).toEqual({ known: [1, 2, 7], pending: [] });
  });
});

describe("suggestFromNotes", () => {
  const catalog = buildCatalog(
    [
      { id: 1, name: "Bäckerei Huber", comment: "Kontakte: Sepp\nThemen: Website" },
      { id: 2, name: "DUSW" },
    ],
    [
      { id: 11, name: "Retainer", customer: 1 },
      { id: 21, name: "Messe", customer: 2 },
    ],
    [{ id: 4, name: "Design", project: null }],
    undefined,
    ["Patrick"],
  );
  const notes = (projectId: number, description: string, count: number, daysAgo = 1): HistoryEntry[] =>
    Array.from({ length: count }, (_, index) => ({
      projectId,
      activityId: 4,
      begin: new Date(2026, 10, 26 - daysAgo - index, 10),
      description,
    }));

  it("proposes people and terms that recur in a customer's notes", () => {
    const entries = [
      ...notes(11, "Call mit Frau Maier wegen Flyer", 3),
      ...notes(11, "Flyer Korrektur", 1),
      ...notes(21, "Roll-Ups, Maier", 3),
    ];
    expect(suggestFromNotes(entries, catalog, now, new Set())).toEqual([
      { customerId: 1, customer: "Bäckerei Huber", text: "Flyer", kind: "topics", key: "1:flyer" },
      { customerId: 1, customer: "Bäckerei Huber", text: "Frau Maier", kind: "contacts", key: "1:maier" },
      { customerId: 2, customer: "DUSW", text: "Maier", kind: "topics", key: "2:maier" },
      { customerId: 2, customer: "DUSW", text: "Roll-Ups", kind: "topics", key: "2:roll ups" },
    ]);
    // Asked once: answered suggestions stay away.
    expect(
      suggestFromNotes(entries, catalog, now, new Set(["1:flyer", "2:maier", "2:roll ups"])).map(
        (item) => item.key,
      ),
    ).toEqual(["1:maier"]);
  });

  it("leaves out what is known, generic, a colleague's name, rare, old or of no customer", () => {
    const entries = [
      // In the profile, the customer's own name, the activity, a colleague.
      ...notes(11, "Sepp Website Huber Design Patrick", 4),
      // Says how one worked, not on what.
      ...notes(11, "Meeting Abstimmung Call", 4),
      // Only twice.
      ...notes(11, "Newsletter", 2),
      // Longer ago than 30 days, in the future, or on a project the catalog does not have.
      ...notes(11, "Imagefilm", 3, 40),
      ...notes(11, "Zukunft", 3, -10),
      ...notes(99, "Fremd", 3),
      // Lowercase words and short ones are no names; twice in one note counts once.
      ...notes(11, "korrektur an AB und Kampagne Kampagne", 1),
      { projectId: 11, activityId: 4, begin: new Date(2026, 10, 25, 10), description: null },
    ];
    expect(suggestFromNotes(entries, catalog, now, new Set())).toEqual([]);
  });

  it("takes a word for a person once it was seen with a title", () => {
    const entries = [...notes(21, "Becker Angebot", 2), ...notes(21, "Herr Becker", 1, 5)];
    expect(suggestFromNotes(entries, catalog, now, new Set())).toEqual([
      { customerId: 2, customer: "DUSW", text: "Herr Becker", kind: "contacts", key: "2:becker" },
    ]);
    // The other way round: the title first, then without.
    const reversed = [...notes(21, "Herr Becker", 1), ...notes(21, "Becker", 2, 5)];
    expect(suggestFromNotes(reversed, catalog, now, new Set())[0]).toMatchObject({
      text: "Herr Becker",
      kind: "contacts",
    });
  });
});

describe("putting a suggestion or a spelling into a profile", () => {
  const profile = {
    aliases: ["Huber"],
    contacts: [
      { name: "Giuseppe Rossi", variants: ["Gigi"] },
      { name: "Christian", variants: [] },
    ],
    topics: ["Website"],
  };

  it("adds a contact or a topic", () => {
    const base = { customerId: 1, customer: "X", key: "k" };
    expect(withSuggestion(profile, { ...base, text: "Frau Maier", kind: "contacts" }).contacts[2]).toEqual({
      name: "Frau Maier",
      variants: [],
    });
    expect(withSuggestion(profile, { ...base, text: "Flyer", kind: "topics" }).topics).toEqual([
      "Website",
      "Flyer",
    ]);
  });

  it("files a corrected spelling with the contact it sounds like, else as an alias", () => {
    expect(withVariant(profile, "dschuseppe").contacts[0]).toEqual({
      name: "Giuseppe Rossi",
      variants: ["Gigi", "Dschuseppe"],
    });
    expect(withVariant(profile, "tschigi").contacts[0]!.variants).toEqual(["Gigi", "Tschigi"]);
    expect(withVariant(profile, "kristjan").contacts[1]!.variants).toEqual(["Kristjan"]);
    expect(withVariant(profile, "hubabäck")).toMatchObject({
      aliases: ["Huber", "Hubabäck"],
      contacts: profile.contacts,
    });
    expect(withVariant(EMPTY_PROFILE, "solartek").aliases).toEqual(["Solartek"]);
  });
});
