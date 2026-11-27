import { buildCatalog } from "../quickEntry/catalog";
import { buildHistory } from "../quickEntry/history";

/**
 * A small agency's catalog and the sentences multi-entry input is tested and
 * measured with. Used by the tests of the rules and by the measurement of
 * the local language model; not part of the app.
 */

/** Thursday 26 November 2026, 14:20. */
export const now = new Date(2026, 10, 26, 14, 20);

export const catalog = buildCatalog(
  [
    { id: 1, name: "DUSW" },
    { id: 2, name: "SolarTech NRW" },
    { id: 3, name: "K&K Global Solutions" },
    { id: 4, name: "Adversum" },
  ],
  [
    { id: 11, name: "Retainer", customer: 1 },
    { id: 21, name: "Imagefilm", customer: 2 },
    { id: 31, name: "Landingpage", customer: 3 },
    { id: 41, name: "Intern", customer: 4 },
  ],
  [
    { id: 1, name: "Projektmanagement", project: null },
    { id: 2, name: "Austausch", project: null },
    { id: 4, name: "Design", project: null },
    { id: 5, name: "Entwicklung", project: null },
    { id: 8, name: "Buchhaltung", project: null },
  ],
  {
    customers: { "1": ["gigi", "giuseppe"] },
    projects: {},
    activities: { "2": ["call", "telefonat", "meeting"] },
  },
);
// What is usually booked: design for DUSW, development for the others.
export const history = buildHistory(
  [
    ...Array.from({ length: 6 }, (_, index) => ({ projectId: 11, activityId: 4, days: index + 1 })),
    ...Array.from({ length: 4 }, (_, index) => ({ projectId: 21, activityId: 5, days: index + 1 })),
    ...Array.from({ length: 4 }, (_, index) => ({ projectId: 31, activityId: 5, days: index + 1 })),
    ...Array.from({ length: 4 }, (_, index) => ({ projectId: 41, activityId: 8, days: index + 1 })),
  ].map(({ projectId, activityId, days }) => ({
    projectId,
    activityId,
    begin: new Date(2026, 10, 26 - days, 10, 0),
  })),
  now,
);

/** The 27 sentences of `sentences.test.ts`, in its order. */
export const SENTENCES: readonly string[] = [
  "Ich hab eine Stunde an DUSW Design gearbeitet, dazwischen 10 Minuten K&K Call",
  "Die letzten 3 Stunden immer wieder DUSW Designs je 7 Minuten, 8 mal kurz mit Gigi auf WhatsApp, der Rest K&K Landingpage",
  "Von 9 bis 12 SolarTech, danach eine halbe Stunde Adversum intern",
  "Ich hab eine Stunde an DUSW Design gearbeitet",
  "DUSW Design, Roll-Ups für die Hallenfußball-Meisterschaft, zwei Stunden",
  "Eine Stunde DUSW Design und 10 Minuten K&K Call",
  "Zwei Stunden SolarTech Entwicklung, dazwischen eine Viertelstunde Pause, danach 20 Minuten Korrekturen",
  "Erst anderthalb Stunden K&K Landingpage, dann 30 Minuten DUSW Projektmanagement",
  "DUSW Design eine Stunde, vorher 20 Minuten Adversum Buchhaltung",
  "Heute von 8 bis 10 SolarTech Entwicklung, von 10 bis 11 Uhr 30 K&K Call mit Patrick",
  "Gestern drei Stunden SolarTech Imagefilm, dazwischen 20 Minuten mit Gigi telefoniert",
  "Die letzte Stunde DUSW Design, zwischendurch kurz K&K Call",
  "Die letzten zwei Stunden 45 Minuten DUSW Projektmanagement, der Rest Adversum intern",
  "Drei mal je 10 Minuten K&K Call, danach eine Stunde DUSW Design",
  "Die letzten 2 Stunden mehrmals kurz mit Gigi telefoniert, ansonsten DUSW Design",
  "1h dusw design, dazwischen 10 min k&k call",
  "Von 13 bis 14 Uhr DUSW Design, danach 20 Minuten K&K Landingpage",
  "30 Minuten DUSW Projektmanagement, 45 Minuten SolarTech Entwicklung, 15 Minuten Adversum Buchhaltung",
  "Eine Stunde DUSW Design, danach 20 Minuten Projektmanagement",
  "Anderthalb Stunden an der K&K Landingpage gesessen, zwischendurch zweimal kurz Gigi am Telefon",
  "Eine halbe Stunde DUSW Design, dazwischen 45 Minuten K&K Call",
  "Von 9 bis 12 SolarTech Entwicklung, dazwischen eine halbe Stunde Mittagspause",
  "DUSW Design zwei Stunden und K&K Call eine halbe Stunde",
  "DUSW Projektmanagement, Gigi Call seit zehn Uhr",
  "Am Montag von 9 bis 11 DUSW Design, danach eine Stunde K&K Call",
  "Eine Stunde Dingsbums, danach 20 Minuten Kram",
  "DUSW Design, K&K Call",
];
