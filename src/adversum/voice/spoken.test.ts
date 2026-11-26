import { describe, expect, it } from "vitest";
import { buildCatalog } from "../quickEntry/catalog";
import { buildHistory, EMPTY_HISTORY, type HistoryEntry } from "../quickEntry/history";
import type { TimeSpec } from "../quickEntry/timeParser";
import { interpretSpoken, readSpoken, type SpokenReading } from "./spoken";
import { numberWord } from "./spokenNumbers";
import { rewriteSpokenTime, spokenToken } from "./spokenTime";

/** Thursday, 14:20. */
const now = new Date(2026, 10, 26, 14, 20);

const customers = [
  { id: 1, name: "DUSW" },
  { id: 2, name: "SolarTech NRW" },
  { id: 3, name: "K&K Global Solutions" },
  { id: 4, name: "Adversum" },
  { id: 5, name: "Herosmile" },
  { id: 6, name: "Haus am See" },
];
const projects = [
  { id: 11, name: "Retainer", customer: 1 },
  { id: 12, name: "Website Relaunch", customer: 1 },
  { id: 21, name: "Imagefilm", customer: 2 },
  { id: 22, name: "Social Media", customer: 2 },
  { id: 31, name: "Messeauftritt", customer: 3 },
  { id: 41, name: "Intern", customer: 4 },
  { id: 51, name: "Onlineshop", customer: 5 },
  { id: 61, name: "Broschüre", customer: 6 },
];
const activities = [
  { id: 1, name: "Projektmanagement", project: null },
  { id: 2, name: "Austausch", project: null },
  { id: 3, name: "Konzeption", project: null },
  { id: 4, name: "Design", project: null },
  { id: 5, name: "Entwicklung", project: null },
  { id: 6, name: "Videoschnitt", project: null },
  { id: 7, name: "Videodreh", project: null },
  { id: 8, name: "Buchhaltung", project: null },
  { id: 9, name: "Recherche", project: null },
];
const catalog = buildCatalog(customers, projects, activities, {
  customers: { "3": ["kaka"] },
  projects: {},
  activities: { "1": ["pm"] },
});

function past(
  projectId: number,
  activityId: number,
  count: number,
  description?: string,
): HistoryEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    projectId,
    activityId,
    begin: new Date(2026, 10, 25 - index * 2, 10, 0),
    description,
  }));
}
const history = buildHistory(
  [
    ...past(11, 1, 6, "Planung Kampagne"),
    ...past(11, 2, 4, "Gigi Call"),
    ...past(11, 2, 2, "Telefonat Gigi"),
    ...past(12, 4, 3, "Startseite"),
    ...past(12, 5, 2),
    ...past(21, 6, 5, "Rohschnitt"),
    ...past(21, 7, 2),
    ...past(22, 3, 2, "Redaktionsplan"),
    ...past(31, 4, 3, "Standdesign"),
    ...past(41, 8, 4, "in Q3"),
    ...past(51, 5, 5, "Checkout"),
    ...past(51, 9, 1),
  ],
  now,
);

function read(sentence: string): SpokenReading {
  return readSpoken(sentence, catalog, history, now);
}

interface Entry {
  customer: string;
  project: string;
  activity: string;
  note: string;
  time: TimeSpec;
  autoSelect: boolean;
}

/** The first suggestion for a sentence that is an entry. */
function entry(sentence: string): Entry {
  const reading = read(sentence);
  if (reading.kind !== "entry") throw new Error(`"${sentence}" was read as ${reading.kind}`);
  const [first] = reading.result.suggestions;
  if (!first) throw new Error(`"${sentence}" has no suggestion`);
  return {
    customer: first.combination.customer,
    project: first.combination.project,
    activity: first.combination.activity,
    note: first.note,
    time: reading.result.time,
    autoSelect: reading.result.autoSelect,
  };
}

function at(hour: number, minute = 0): Date {
  return new Date(2026, 10, 26, hour, minute);
}

describe("thirty things people say", () => {
  it("1: the reference sentence", () => {
    expect(entry("DUSW Projektmanagement, Gigi Call seit zehn Uhr.")).toEqual({
      customer: "DUSW",
      project: "Retainer",
      activity: "Projektmanagement",
      note: "Gigi Call",
      time: { kind: "start", begin: at(10) },
      autoSelect: true,
    });
  });

  it("2: a call in the past, found through the name in old notes", () => {
    expect(entry("Ich hab von 10 bis 11 mit Gigi telefoniert.")).toEqual({
      customer: "DUSW",
      project: "Retainer",
      activity: "Austausch",
      note: "Telefonat Gigi",
      time: { kind: "range", begin: at(10), end: at(11) },
      autoSelect: true,
    });
  });

  it("3 to 6: single-word commands", () => {
    expect(read("Stopp.")).toEqual({ kind: "command", command: "stop" });
    expect(read("Pause")).toEqual({ kind: "command", command: "pause" });
    expect(read("Weiter.")).toEqual({ kind: "command", command: "resume" });
    expect(read("Zurück")).toEqual({ kind: "command", command: "previous" });
  });

  it("7: a note for the running timer", () => {
    expect(read("Notiz: Angebot nachfassen.")).toEqual({
      kind: "note",
      text: "Angebot nachfassen",
    });
  });

  it("8: fillers and 'ich mache jetzt' are ignored", () => {
    expect(entry("Äh, ich mache jetzt SolarTech NRW Videoschnitt.")).toMatchObject({
      customer: "SolarTech NRW",
      project: "Imagefilm",
      activity: "Videoschnitt",
      note: "",
      time: { kind: "none" },
      autoSelect: true,
    });
  });

  it("9: 'starte bitte' and a name with an ampersand", () => {
    expect(entry("Starte bitte K&K Design.")).toMatchObject({
      customer: "K&K Global Solutions",
      project: "Messeauftritt",
      activity: "Design",
      note: "",
      autoSelect: true,
    });
  });

  it("10: the project before the customer, with glue words", () => {
    expect(entry("Ich arbeite jetzt an der Website für DUSW")).toMatchObject({
      customer: "DUSW",
      project: "Website Relaunch",
      note: "",
    });
  });

  it("11: 'seit halb zehn'", () => {
    expect(entry("seit halb zehn Herosmile Onlineshop Entwicklung")).toMatchObject({
      customer: "Herosmile",
      project: "Onlineshop",
      activity: "Entwicklung",
      time: { kind: "start", begin: at(9, 30) },
      autoSelect: true,
    });
  });

  it("12: 'vor zwanzig Minuten … angefangen'", () => {
    expect(
      entry("Vor zwanzig Minuten hab ich mit SolarTech Social Media angefangen"),
    ).toMatchObject({
      customer: "SolarTech NRW",
      project: "Social Media",
      note: "",
      time: { kind: "start", begin: at(14, 0) },
    });
  });

  it("13: 'seit einer halben Stunde' is a start half an hour ago", () => {
    expect(entry("DUSW Austausch, seit einer halben Stunde")).toMatchObject({
      customer: "DUSW",
      project: "Retainer",
      activity: "Austausch",
      note: "",
      time: { kind: "start", begin: at(13, 50) },
    });
  });

  it("14: 'von neun bis halb elf'", () => {
    expect(entry("Ich war von neun bis halb elf beim Videodreh für SolarTech.")).toMatchObject({
      customer: "SolarTech NRW",
      project: "Imagefilm",
      activity: "Videodreh",
      note: "",
      time: { kind: "range", begin: at(9), end: at(10, 30) },
    });
  });

  it("15: 'anderthalb Stunden … gemacht'", () => {
    expect(entry("Anderthalb Stunden Buchhaltung für Adversum gemacht")).toMatchObject({
      customer: "Adversum",
      project: "Intern",
      activity: "Buchhaltung",
      note: "",
      time: { kind: "range", begin: at(12, 50), end: at(14, 20) },
    });
  });

  it("16 and 17: commands with words around them", () => {
    expect(read("Timer stoppen bitte")).toEqual({ kind: "command", command: "stop" });
    expect(read("Mach mal Pause")).toEqual({ kind: "command", command: "pause" });
    expect(read("Zurück zur letzten Aufgabe")).toEqual({ kind: "command", command: "previous" });
    expect(read("Feierabend!")).toEqual({ kind: "command", command: "stop" });
  });

  it("18: a note without a colon", () => {
    expect(read("Notiz, Logo-Varianten an Patrick geschickt")).toEqual({
      kind: "note",
      text: "Logo-Varianten an Patrick geschickt",
    });
    expect(read("notiere bitte mal: rückruf bis Freitag ")).toEqual({
      kind: "note",
      text: "Rückruf bis Freitag",
    });
  });

  it("19: present tense, no time", () => {
    expect(entry("Ich telefoniere gerade mit Gigi")).toMatchObject({
      customer: "DUSW",
      project: "Retainer",
      activity: "Austausch",
      note: "Telefonat Gigi",
      time: { kind: "none" },
      autoSelect: true,
    });
  });

  it("20: a learned alias for a name speech recognition gets wrong", () => {
    expect(entry("Kaka Design")).toMatchObject({
      customer: "K&K Global Solutions",
      activity: "Design",
      autoSelect: true,
    });
  });

  it("21: a slightly misheard name and '13 Uhr 15'", () => {
    expect(entry("Solartec Imagefilm Schnitt seit 13 Uhr 15")).toMatchObject({
      customer: "SolarTech NRW",
      project: "Imagefilm",
      activity: "Videoschnitt",
      note: "",
      time: { kind: "start", begin: at(13, 15) },
    });
  });

  it("22: 'zwischen acht und neun'", () => {
    expect(entry("Zwischen acht und neun Recherche für Herosmile")).toMatchObject({
      customer: "Herosmile",
      activity: "Recherche",
      note: "",
      time: { kind: "range", begin: at(8), end: at(9) },
    });
  });

  it("23: a note after the task", () => {
    expect(entry("DUSW Website Design, Startseite überarbeiten")).toMatchObject({
      customer: "DUSW",
      project: "Website Relaunch",
      activity: "Design",
      note: "Startseite überarbeiten",
      autoSelect: true,
    });
  });

  it("24: the note first, then the task", () => {
    expect(entry("Gigi Call für DUSW Projektmanagement")).toMatchObject({
      customer: "DUSW",
      project: "Retainer",
      activity: "Projektmanagement",
      note: "Gigi Call",
    });
  });

  it("25: 'okay, also weiter mit dem …' is not the resume command", () => {
    expect(entry("Okay, also weiter mit dem Messeauftritt")).toMatchObject({
      customer: "K&K Global Solutions",
      project: "Messeauftritt",
      note: "",
    });
  });

  it("26: 'zwei Stunden an der … gesessen'", () => {
    expect(
      entry("Ich hab gerade zwei Stunden an der SolarTech Konzeption gesessen"),
    ).toMatchObject({
      customer: "SolarTech NRW",
      project: "Social Media",
      activity: "Konzeption",
      note: "",
      time: { kind: "range", begin: at(12, 20), end: at(14, 20) },
    });
  });

  it("27: 'von 14 Uhr bis jetzt'", () => {
    expect(entry("Von 14 Uhr bis jetzt Videoschnitt Imagefilm")).toMatchObject({
      customer: "SolarTech NRW",
      project: "Imagefilm",
      activity: "Videoschnitt",
      time: { kind: "range", begin: at(14), end: at(14, 20) },
    });
  });

  it("28: terse, with an alias, activity first", () => {
    expect(entry("pm dusw")).toMatchObject({
      customer: "DUSW",
      project: "Retainer",
      activity: "Projektmanagement",
      note: "",
    });
  });

  it("29: what the recognizer writes for silence is nothing", () => {
    expect(read("Untertitel der Amara.org-Community")).toEqual({ kind: "empty" });
    expect(read("[Musik]")).toEqual({ kind: "empty" });
    expect(read("  ")).toEqual({ kind: "empty" });
    expect(read("Vielen Dank fürs Zuschauen!")).toEqual({ kind: "empty" });
  });

  it("30: the verb hints at the activity, the time comes last", () => {
    expect(
      entry("Ich hab mit Herosmile telefoniert, von elf Uhr dreißig bis zwölf"),
    ).toEqual({
      customer: "Herosmile",
      project: "Onlineshop",
      activity: "Austausch",
      note: "Telefonat",
      time: { kind: "range", begin: at(11, 30), end: at(12) },
      autoSelect: true,
    });
  });
});

describe("what the Small model really wrote for synthesized speech", () => {
  it("is read like the sentences above", () => {
    expect(entry("DUSW Projektmanagement, 3D-Call seit 10 Uhr.")).toMatchObject({
      customer: "DUSW",
      activity: "Projektmanagement",
      note: "3d Call",
      time: { kind: "start", begin: at(10) },
    });
    expect(entry("Ich habe von 10 bis 11 mit Gigi telefoniert.")).toMatchObject({
      customer: "DUSW",
      activity: "Austausch",
      note: "Telefonat Gigi",
      time: { kind: "range", begin: at(10), end: at(11) },
    });
    expect(entry("Ich mache jetzt SolarTech NRW Videoschnitt.")).toMatchObject({
      customer: "SolarTech NRW",
      activity: "Videoschnitt",
      note: "",
    });
    expect(read("Stop.")).toEqual({ kind: "command", command: "stop" });
    expect(read("Notiz, Angebot nachfassen.")).toEqual({
      kind: "note",
      text: "Angebot nachfassen",
    });
    // Both spellings came back for the same recording.
    for (const sentence of ["K&K Design, seit Halb 3.", "K&K Design, seit halb drei."]) {
      expect(entry(sentence)).toMatchObject({
        customer: "K&K Global Solutions",
        activity: "Design",
        note: "",
        // At 14:20, "halb drei" in the past is 2:30 at night.
        time: { kind: "start", begin: at(2, 30) },
      });
    }
    expect(entry("Vor 20 Minuten habe ich mit der DUSW Website angefangen.")).toMatchObject({
      customer: "DUSW",
      project: "Website Relaunch",
      note: "",
      time: { kind: "start", begin: at(14, 0) },
    });
  });
});

describe("readSpoken", () => {
  it("does not start by itself when nothing names a task", () => {
    const reading = read("Irgendwas mit Zetteln sortieren");
    expect(reading.kind).toBe("entry");
    if (reading.kind !== "entry") return;
    expect(reading.text).toBe("Irgendwas mit Zetteln sortieren");
    expect(reading.result.autoSelect).toBe(false);
    expect(reading.result.confidence).toBe(0);
    expect(reading.result.suggestions[0]!.note).toBe("Irgendwas mit Zetteln sortieren");
  });

  it("keeps glue words that belong to a name", () => {
    const reading = read("Haus am See Broschüre Design");
    if (reading.kind !== "entry") throw new Error("not an entry");
    const [first] = reading.result.suggestions;
    expect(first!.combination.customer).toBe("Haus am See");
    expect(first!.words).toEqual({
      customer: ["haus", "am", "see"],
      project: ["broschuere"],
      activity: ["design"],
    });
    expect(first!.note).toBe("");
  });

  it("keeps glue words inside a note and drops them at its edges", () => {
    expect(entry("DUSW Projektmanagement Call mit Gigi und dem Team für")).toMatchObject({
      note: "Call mit Gigi und dem Team",
    });
  });

  it("takes a loose match after the note began as part of the note", () => {
    // "Proj" would name "Projektmanagement" at the start, not after "Gigi".
    expect(entry("DUSW Austausch Gigi Proj")).toMatchObject({
      activity: "Austausch",
      note: "Gigi Proj",
    });
  });

  it("marks a time in the future", () => {
    expect(entry("DUSW Design seit 18 Uhr").time).toEqual({ kind: "future" });
  });

  it("works without history, on the words alone", () => {
    const reading = readSpoken("Herosmile Recherche", catalog, EMPTY_HISTORY, now);
    if (reading.kind !== "entry") throw new Error("not an entry");
    expect(reading.result.suggestions[0]!.combination.key).toBe("51-9");
  });

  it("passes on the parser's own command words", () => {
    expect(read("Resume")).toEqual({ kind: "command", command: "resume" });
  });
});

describe("interpretSpoken", () => {
  const text = (sentence: string) => {
    const intent = interpretSpoken(sentence, now);
    return intent.kind === "entry" ? intent.text : intent.kind;
  };

  it("removes fillers, lead-ins and trailing words", () => {
    expect(text("Ähm, also ich bin jetzt bei DUSW Design, bitte starten")).toBe("DUSW Design");
    expect(text("Neuer Timer für Herosmile Recherche")).toBe("Herosmile Recherche");
    expect(text("und dann als nächstes K&K Messeauftritt, los")).toBe("K&K Messeauftritt");
    expect(text("DUSW / Design & Layout")).toBe("DUSW Design Layout");
  });

  it("derives note and activity hints from the verb", () => {
    expect(interpretSpoken("Mit Patrick über das Angebot gesprochen", now)).toEqual({
      kind: "entry",
      text: "Patrick über das Angebot",
      noteLead: "Gespräch",
      activityHints: expect.arrayContaining(["austausch", "call"]),
    });
    expect(interpretSpoken("Am Onlineshop programmiert", now)).toMatchObject({
      text: "Onlineshop",
      noteLead: "",
      activityHints: ["entwicklung", "programmierung", "development", "umsetzung"],
    });
    // A verb that only says "worked" tells nothing, the next one does.
    expect(interpretSpoken("gearbeitet, telefoniert", now)).toMatchObject({
      text: "",
      noteLead: "Telefonat",
    });
    expect(interpretSpoken("Ich hab gearbeitet", now)).toEqual({ kind: "empty" });
  });

  it("does not take a sentence with other words for a command", () => {
    expect(text("Pause DUSW")).toBe("Pause DUSW");
    expect(text("Stopp und weiter")).toBe("Stopp und weiter");
    expect(text("Notizbuch kaufen")).toBe("Notizbuch kaufen");
  });
});

describe("rewriteSpokenTime", () => {
  const rewrite = (sentence: string) =>
    rewriteSpokenTime(sentence.split(" ").map(spokenToken), now)
      .map((token) => token.raw)
      .join(" ");

  it("writes clock times with digits", () => {
    expect(rewrite("seit zehn Uhr dreißig")).toBe("seit 10:30");
    expect(rewrite("um viertel nach zehn")).toBe("um viertel nach 10");
    expect(rewrite("seit zehn nach neun")).toBe("seit 9:10");
    expect(rewrite("ab zwanzig vor zehn")).toBe("ab 9:40");
    expect(rewrite("seit fünf vor eins")).toBe("seit 0:55");
    expect(rewrite("seit kurz nach zehn")).toBe("seit 10");
    expect(rewrite("um kurz vor elf")).toBe("um 11");
    expect(rewrite("gegen zehn angefangen")).toBe("um 10 angefangen");
    expect(rewrite("gegen Mittag")).toBe("gegen Mittag");
    expect(rewrite("seit 10 Uhr 30 Minuten Pause")).toBe("seit 10 Uhr 30 Minuten Pause");
    expect(rewrite("Design seit")).toBe("Design seit");
  });

  it("writes durations the way the time parser reads them", () => {
    expect(rewrite("seit zwanzig Minuten")).toBe("vor 20 Minuten");
    expect(rewrite("ab 1,5 h")).toBe("vor 1,5 h");
    expect(rewrite("seit 2 Stunden 30 Minuten")).toBe("vor 2h30");
    expect(rewrite("1 Stunde und 15 Recherche")).toBe("1h15 Recherche");
    expect(rewrite("3 Stunden Recherche")).toBe("3 Stunden Recherche");
    expect(rewrite("eine Stunde Recherche")).toBe("1 h Recherche");
    expect(rewrite("eine Minute")).toBe("1 min");
    expect(rewrite("Viertelstunde Austausch")).toBe("15 min Austausch");
    expect(rewrite("vor einer Dreiviertelstunde")).toBe("vor 45 min");
    expect(rewrite("halbe Stunde")).toBe("30 min");
    expect(rewrite("vor ner halben Stunde")).toBe("vor 30 min");
    expect(rewrite("zweieinhalb Stunden Dreh")).toBe("2,5 h Dreh");
    expect(rewrite("anderthalb Seiten Text")).toBe("anderthalb Seiten Text");
    expect(rewrite("eine halbe Seite")).toBe("eine halbe Seite");
  });

  it("completes ranges", () => {
    expect(rewrite("zwischen acht und neun")).toBe("von 8 bis 9");
    expect(rewrite("zwischen Tür und Angel")).toBe("von Tür bis Angel");
    expect(rewrite("zwischen den Stühlen")).toBe("zwischen den Stühlen");
    expect(rewrite("10 bis 11 Uhr Austausch")).toBe("von 10 bis 11 Uhr Austausch");
    expect(rewrite("DUSW 10 Uhr bis 11")).toBe("DUSW von 10 Uhr bis 11");
    expect(rewrite("halb zehn bis elf")).toBe("von halb 10 bis 11");
    expect(rewrite("von 10 bis eben")).toBe("von 10 bis 14:20");
    expect(rewrite("Angebot bis Freitag")).toBe("Angebot bis Freitag");
    expect(rewrite("bis Freitag")).toBe("bis Freitag");
    expect(rewrite("Uhr bis 5")).toBe("Uhr bis 5");
  });

  it("leaves number words alone away from a time", () => {
    expect(rewrite("Drei Angebote schreiben")).toBe("Drei Angebote schreiben");
    expect(rewrite("zwei Stunden")).toBe("2 Stunden");
  });
});

describe("numberWord", () => {
  it("reads German number words up to 99", () => {
    expect(numberWord("null")).toBe(0);
    expect(numberWord("zwo")).toBe(2);
    expect(numberWord("zwoelf")).toBe(12);
    expect(numberWord("dreissig")).toBe(30);
    expect(numberWord("einundzwanzig")).toBe(21);
    expect(numberWord("neunundneunzig")).toBe(99);
    expect(numberWord("neunzig")).toBe(90);
  });

  it("returns null for everything else", () => {
    for (const word of ["hundert", "undzwanzig", "einund", "ein", "dusw", "", "zehnundzwanzig"]) {
      expect(numberWord(word)).toBeNull();
    }
  });
});
