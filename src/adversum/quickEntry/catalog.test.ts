import { describe, expect, it } from "vitest";
import { buildCatalog, combinationKey } from "./catalog";

const customers = [
  { id: 1, name: "DUSW Unternehmensgruppe", color: "#0f766e" },
  { id: 2, name: "Müller & Söhne", color: null, "color-safe": "#abcdef" },
  { id: 3, name: "Hidden Customer", visible: false },
  { id: 4, name: "No Projects" },
];
const projects = [
  { id: 11, name: "Marketing Retainer", customer: 1 },
  { id: 12, name: "Druckdaten", customer: 1, globalActivities: false },
  { id: 21, name: "Marketing Retainer", customer: 2 },
  { id: 22, name: "Archiv", customer: 2, visible: false },
  { id: 31, name: "Secret", customer: 3 },
  { id: 13, name: "Leer", customer: 1, globalActivities: false },
  { id: 99, name: "Orphan", customer: 404 },
];
const activities = [
  { id: 1, name: "Projektmanagement", project: null, color: "#10b981" },
  { id: 2, name: "Austausch", project: null },
  { id: 3, name: "Reinzeichnung", project: 12, color: null, "color-safe": "#0ea5e9" },
  { id: 4, name: "Alt", project: null, visible: false },
  { id: 5, name: "Reporting", project: 11 },
];

describe("buildCatalog", () => {
  const catalog = buildCatalog(customers, projects, activities, {
    customers: { "1": ["gigi"] },
    projects: { "11": ["Retainer DUSW"] },
    activities: { "1": ["pm"], "2": ["call", "Telefonat", "meeting"] },
  });

  it("lists every valid combination of visible entities", () => {
    expect(catalog.combinations.map((item) => item.key)).toEqual([
      "11-5", "11-1", "11-2", "12-3", "21-1", "21-2",
    ]);
    expect(catalog.combinations[0]).toEqual({
      key: combinationKey(11, 5),
      customerId: 1,
      customer: "DUSW Unternehmensgruppe",
      customerColor: "#0f766e",
      projectId: 11,
      project: "Marketing Retainer",
      activityId: 5,
      activity: "Reporting",
      activityColor: "",
    });
    expect(catalog.combinations.find((item) => item.key === "12-3")?.activityColor).toBe("#0ea5e9");
    expect(catalog.combinations.find((item) => item.key === "21-1")?.customerColor).toBe("#abcdef");
  });

  it("indexes names, acronyms and aliases of the entities in use", () => {
    expect([...catalog.customers.keys()]).toEqual([1, 2]);
    expect(catalog.customers.get(1)).toEqual({
      words: ["dusw", "unternehmensgruppe"],
      aliases: ["gigi"],
      acronym: "du",
    });
    expect(catalog.customers.get(2)?.words).toEqual(["mueller", "muller", "soehne", "sohne"]);
    expect(catalog.projects.get(11)).toEqual({
      words: ["marketing", "retainer"],
      aliases: ["retainer", "dusw"],
      acronym: "mr",
    });
    expect(catalog.activities.get(2)).toEqual({
      words: ["austausch"],
      aliases: ["call", "telefonat", "meeting"],
      acronym: "",
    });
    expect(catalog.activities.has(4)).toBe(false);
    expect(catalog.projects.has(13)).toBe(false);
  });

  it("keeps colleagues apart from customers", () => {
    const withTeam = buildCatalog(
      customers,
      projects,
      activities,
      { customers: { "1": ["gigi", "Patrick"] }, projects: {}, activities: {} },
      ["Patrick", "Ema Maria"],
    );
    expect([...withTeam.team]).toEqual(["patrick", "ema", "maria"]);
    // His name was stored as an alias once; it no longer counts.
    expect(withTeam.customers.get(1)?.aliases).toEqual(["gigi"]);
    expect(catalog.team.size).toBe(0);
  });

  it("works without aliases", () => {
    const plain = buildCatalog(customers, projects, activities);
    expect(plain.customers.get(1)?.aliases).toEqual([]);
    expect(plain.combinations).toHaveLength(6);
  });
});
