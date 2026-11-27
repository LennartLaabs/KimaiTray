/**
 * Ten sentences the rules alone do not read well: intentions that were not
 * carried out, amounts far from their task, "sonst", "à", "je … für A, B und
 * C". They are what the language model is for, and what it is measured on
 * (`localModel.bench.test.ts`).
 *
 * `expect` lists the activities in the order said: the customer, and the
 * amount in one of the accepted readings ("60" minutes, "3x10" counted,
 * "?x5" counted without a number, "09:00-10:30" a time span, "rest", "?"
 * nothing said).
 */
export interface HardSentence {
  sentence: string;
  expect: { customer: string; amount: string[] }[];
  /**
   * What a model that reads the sentence well would answer, in the fields of
   * `EXTRACT_SCHEMA` (left-out fields are 0, false, "none" or empty).
   */
  ideal: Record<string, string | number | boolean>[];
}

export const HARD_SENTENCES: HardSentence[] = [
  {
    sentence:
      "zwischendurch immer mal kurz bei Gigi, sonst den ganzen Nachmittag K&K Landingpage, und um 4 noch ein Call mit SolarTech",
    expect: [
      { customer: "DUSW", amount: ["?x5"] },
      { customer: "K&K", amount: ["rest", "?"] },
      { customer: "SolarTech", amount: ["?", "5"] },
    ],
    ideal: [
      { task: "Gigi", repeated: true, vague: true, relation: "within" },
      { task: "K&K Landingpage", rest: true },
      { task: "SolarTech Call" },
    ],
  },
  {
    sentence:
      "Heute Vormittag erst zwei Stunden Konzept für SolarTech, dann bis zur Mittagspause Kleinkram für Adversum, also Buchhaltung und so, vielleicht ne Dreiviertelstunde",
    expect: [
      { customer: "SolarTech", amount: ["120"] },
      { customer: "Adversum", amount: ["45"] },
    ],
    ideal: [
      { task: "SolarTech Konzept", minutes: 120 },
      { task: "Adversum Buchhaltung Kleinkram", minutes: 45, relation: "after" },
    ],
  },
  {
    sentence:
      "Den halben Tag DUSW, davon ungefähr anderthalb Stunden Design und der Rest Projektmanagement",
    expect: [
      { customer: "DUSW", amount: ["90"] },
      { customer: "DUSW", amount: ["rest"] },
    ],
    ideal: [
      { task: "DUSW Design", minutes: 90 },
      { task: "DUSW Projektmanagement", rest: true },
    ],
  },
  {
    sentence:
      "Eigentlich wollte ich Design für DUSW machen, hab dann aber eine Stunde mit K&K telefoniert und danach noch zwanzig Minuten die Rechnung für SolarTech geschrieben",
    expect: [
      { customer: "K&K", amount: ["60"] },
      { customer: "SolarTech", amount: ["20"] },
    ],
    ideal: [
      { task: "K&K Telefonat", minutes: 60 },
      { task: "SolarTech Rechnung geschrieben", minutes: 20, relation: "after" },
    ],
  },
  {
    sentence:
      "Von neun bis halb elf Meeting mit SolarTech, direkt im Anschluss bis zwölf DUSW Design",
    expect: [
      { customer: "SolarTech", amount: ["09:00-10:30"] },
      { customer: "DUSW", amount: ["10:30-12:00", "90", "?"] },
    ],
    ideal: [
      { task: "SolarTech Meeting", from: "09:00", to: "10:30" },
      { task: "DUSW Design", from: "10:30", to: "12:00", relation: "after" },
    ],
  },
  {
    sentence:
      "Drei Calls à zehn Minuten mit K&K und zwischen den Calls insgesamt eine Stunde Entwicklung für SolarTech",
    expect: [
      { customer: "K&K", amount: ["3x10"] },
      { customer: "SolarTech", amount: ["60"] },
    ],
    ideal: [
      { task: "K&K Calls", minutes: 10, count: 3, repeated: true },
      { task: "SolarTech Entwicklung", minutes: 60, relation: "within" },
    ],
  },
  {
    sentence: "Je eine halbe Stunde Projektmanagement für DUSW, K&K und SolarTech",
    expect: [
      { customer: "DUSW", amount: ["30"] },
      { customer: "K&K", amount: ["30"] },
      { customer: "SolarTech", amount: ["30"] },
    ],
    ideal: [
      { task: "DUSW Projektmanagement", minutes: 30 },
      { task: "K&K Projektmanagement", minutes: 30 },
      { task: "SolarTech Projektmanagement", minutes: 30 },
    ],
  },
  {
    sentence:
      "Zwei Stunden an der K&K Landingpage, wobei ich zwischendrin zweimal kurz für DUSW was am Design korrigiert hab",
    expect: [
      { customer: "K&K", amount: ["120"] },
      { customer: "DUSW", amount: ["2x5"] },
    ],
    ideal: [
      { task: "K&K Landingpage", minutes: 120 },
      { task: "DUSW Design korrigiert", count: 2, repeated: true, vague: true, relation: "within" },
    ],
  },
  {
    sentence:
      "Ich war den ganzen Vormittag bei SolarTech vor Ort, so von acht bis zwölf, und hab auf der Rückfahrt noch zwanzig Minuten mit Gigi telefoniert",
    expect: [
      { customer: "SolarTech", amount: ["08:00-12:00"] },
      { customer: "DUSW", amount: ["20"] },
    ],
    ideal: [
      { task: "SolarTech vor Ort", from: "08:00", to: "12:00" },
      { task: "Gigi Telefonat", minutes: 20, relation: "after" },
    ],
  },
  {
    sentence:
      "Erst kurz Mails für Adversum, dann anderthalb Stunden K&K Landingpage und zum Schluss eine Viertelstunde Abstimmung mit SolarTech",
    expect: [
      { customer: "Adversum", amount: ["5"] },
      { customer: "K&K", amount: ["90"] },
      { customer: "SolarTech", amount: ["15"] },
    ],
    ideal: [
      { task: "Adversum Mails", vague: true },
      { task: "K&K Landingpage", minutes: 90, relation: "after" },
      { task: "SolarTech Abstimmung", minutes: 15, relation: "after" },
    ],
  },
];
