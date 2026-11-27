import { describe, expect, it } from "vitest";
import {
  domainName,
  mergeProfiles,
  readProfileSentence,
  shortName,
  suggestProfile,
} from "./profileSentence";
import { EMPTY_PROFILE } from "./profileText";

const plain = (names: string[]) => names.map((name) => ({ name, variants: [] }));

describe("a profile said in a sentence", () => {
  it("1: the sentence from the brief", () => {
    expect(
      readProfileSentence(
        "Ansprechpartner Sepp Huber und Frau Maier, intern sagen wir Huber, wir machen Website und Google Ads",
      ),
    ).toEqual({
      aliases: ["Huber"],
      contacts: plain(["Sepp Huber", "Frau Maier"]),
      topics: ["Website", "Google Ads"],
    });
  });

  it("2: dictated without any punctuation", () => {
    expect(
      readProfileSentence(
        "Ansprechpartner ist Sepp Huber und Frau Maier intern sagen wir Huber wir machen Website und Google Ads",
      ),
    ).toEqual({
      aliases: ["Huber"],
      contacts: plain(["Sepp Huber", "Frau Maier"]),
      topics: ["Website", "Google Ads"],
    });
  });

  it("3: a nickname after its contact", () => {
    expect(
      readProfileSentence(
        "Kontakt ist Giuseppe, genannt Gigi, und Christian. Themen sind Roll-Ups, Messestand und Newsletter.",
      ),
    ).toEqual({
      aliases: [],
      contacts: [
        { name: "Giuseppe", variants: ["Gigi"] },
        { name: "Christian", variants: [] },
      ],
      topics: ["Roll-Ups", "Messestand", "Newsletter"],
    });
  });

  it("4: aliases first, a title with a full stop", () => {
    expect(
      readProfileSentence(
        "Die nennen wir intern BH oder Bäcker, Ansprechpartnerin ist Frau Dr. Schmidt",
      ),
    ).toEqual({
      aliases: ["BH", "Bäcker"],
      contacts: plain(["Frau Dr. Schmidt"]),
      topics: [],
    });
  });

  it("5: only what we do for them", () => {
    expect(readProfileSentence("Für die machen wir Social Media, Reels und den Newsletter")).toEqual({
      ...EMPTY_PROFILE,
      topics: ["Social Media", "Reels", "Newsletter"],
    });
  });

  it("6: a nickname in parentheses, 'es geht um'", () => {
    expect(
      readProfileSentence(
        "Zuständig sind Herr Becker (Benni) und Lisa, es geht um Imagefilm und Drohnenaufnahmen",
      ),
    ).toEqual({
      aliases: [],
      contacts: [
        { name: "Herr Becker", variants: ["Benni"] },
        { name: "Lisa", variants: [] },
      ],
      topics: ["Imagefilm", "Drohnenaufnahmen"],
    });
  });

  it("7: terse", () => {
    expect(readProfileSentence("Kürzel SOL, Ansprechpartner Tom")).toEqual({
      aliases: ["SOL"],
      contacts: plain(["Tom"]),
      topics: [],
    });
  });

  it("8: articles are no part of a topic", () => {
    expect(
      readProfileSentence("Wir machen dort die Buchhaltung und kümmern uns um die Website."),
    ).toMatchObject({ topics: ["Buchhaltung", "kümmern uns um die Website"] });
    expect(readProfileSentence("Wir kümmern uns um die Website und den Newsletter")).toMatchObject({
      topics: ["Website", "Newsletter"],
    });
  });

  it("9: labels as in the description, a contact named with 'genannt'", () => {
    expect(
      readProfileSentence(
        "Alias Solartech und Solar; Themen: Photovoltaik. Kontaktperson Giuseppe genannt Gigi alias Beppe",
      ),
    ).toEqual({
      aliases: ["Solartech", "Solar"],
      contacts: [{ name: "Giuseppe", variants: ["Gigi", "Beppe"] }],
      topics: ["Photovoltaik"],
    });
  });

  it("10: a sentence that says nothing of the kind", () => {
    expect(readProfileSentence("Das ist ein neuer Kunde aus Köln, sehr nett.")).toEqual(EMPTY_PROFILE);
    expect(readProfileSentence("")).toEqual(EMPTY_PROFILE);
    // Items that are no words are dropped, a nickname without a contact too.
    expect(readProfileSentence("Kontakte: genannt Gigi, 123, ()")).toEqual({
      ...EMPTY_PROFILE,
      contacts: plain(["genannt Gigi"]),
    });
  });
});

describe("what can be told without anyone saying it", () => {
  it("shortens company names", () => {
    expect(shortName("Bäckerei Huber GmbH & Co. KG")).toBe("Bäckerei Huber");
    expect(shortName("SolarTech NRW UG (haftungsbeschränkt)")).toBe("SolarTech NRW");
    expect(shortName("Müller & Söhne e.K.")).toBe("Müller & Söhne");
    expect(shortName("Verein für Sport e. V.")).toBe("Verein für Sport");
    expect(shortName("Agentur AG, Köln")).toBe("Agentur, Köln");
    expect(shortName("DUSW")).toBe("DUSW");
  });

  it("finds the name in a homepage's address", () => {
    expect(domainName("https://www.baeckerei-huber.de/kontakt")).toBe("baeckerei-huber");
    expect(domainName("herosmile.example")).toBe("herosmile");
    expect(domainName("http://shop.kunde.co.uk")).toBe("kunde");
    expect(domainName("localhost")).toBe("");
    expect(domainName("")).toBe("");
  });

  it("proposes aliases and takes the contact from Kimai", () => {
    expect(
      suggestProfile({
        name: "Bäckerei Huber GmbH",
        contact: "Sepp Huber, Frau Maier",
        homepage: "https://www.huber-backt.de",
      }),
    ).toEqual({
      aliases: ["Bäckerei Huber", "BH", "huber-backt"],
      contacts: plain(["Sepp Huber", "Frau Maier"]),
      topics: [],
    });
    // Nothing that only repeats the name.
    expect(suggestProfile({ name: "Herosmile", homepage: "https://herosmile.de" })).toEqual(
      EMPTY_PROFILE,
    );
    expect(suggestProfile({ name: "DUSW", contact: null, homepage: null })).toEqual(EMPTY_PROFILE);
    expect(
      suggestProfile({ name: "DUSW Unternehmensgruppe", homepage: "https://dusw.example" }).aliases,
    ).toEqual(["DU"]);
    expect(suggestProfile({ name: "Solar Tech GmbH", homepage: "solartech.de" }).aliases).toEqual([
      "Solar Tech",
      "ST",
    ]);
  });

  it("merges what was said into what is there", () => {
    expect(
      mergeProfiles(
        { aliases: ["Huber"], contacts: [{ name: "Giuseppe", variants: ["Gigi"] }], topics: ["Flyer"] },
        { aliases: ["huber", "BH"], contacts: [{ name: "giuseppe", variants: ["Beppe"] }], topics: ["Website"] },
      ),
    ).toEqual({
      aliases: ["Huber", "BH"],
      contacts: [{ name: "Giuseppe", variants: ["Gigi", "Beppe"] }],
      topics: ["Flyer", "Website"],
    });
  });
});
