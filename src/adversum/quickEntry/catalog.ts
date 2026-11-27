import type { ConnectionAliases } from "../settings/adversumSettings";
import { contactNames, parseProfile, type Profile } from "../profile/profileText";
import { normalizeWords, wordVariants } from "./normalize";

/** The Kimai entities the quick entry bar needs; a subset of the API types. */
export interface CatalogCustomer {
  id: number;
  name: string;
  visible?: boolean;
  color?: string | null;
  "color-safe"?: string;
  /** Kimai's description; may hold the profile (`profile/profileText.ts`). */
  comment?: string | null;
}
export interface CatalogProject {
  id: number;
  name: string;
  customer: number;
  visible?: boolean;
  globalActivities?: boolean;
  comment?: string | null;
}
export interface CatalogActivity {
  id: number;
  name: string;
  project: number | null;
  visible?: boolean;
  color?: string | null;
  "color-safe"?: string;
  comment?: string | null;
}

/** The words an entity can be addressed by, already normalized. */
export interface EntityWords {
  /** Words of the name, including short umlaut spellings. */
  words: string[];
  /**
   * Other words for this entity: the user's own aliases, and from the
   * profile in Kimai the team's aliases and the customer's contacts with
   * their nicknames.
   */
  aliases: string[];
  /** Words of the profile's topics: they hint at the entity, no more. */
  topics?: string[];
  /** First letters of the name's words ("mr" for "Marketing Retainer"). */
  acronym: string;
}

/** One startable combination of customer, project and activity. */
export interface Combination {
  key: string;
  customerId: number;
  customer: string;
  customerColor: string;
  projectId: number;
  project: string;
  activityId: number;
  activity: string;
  activityColor: string;
}

export interface QuickCatalog {
  combinations: Combination[];
  customers: ReadonlyMap<number, EntityWords>;
  projects: ReadonlyMap<number, EntityWords>;
  activities: ReadonlyMap<number, EntityWords>;
  /**
   * Names of colleagues, normalized. They are people one works with, not
   * customers: such a word never names a task and never hints at one. It
   * only goes into the note ("Call mit Patrick").
   */
  team: ReadonlySet<string>;
  /** The profiles of the customers in use, as they stand in Kimai. */
  profiles: ReadonlyMap<number, Profile>;
}

export function combinationKey(projectId: number, activityId: number): string {
  return `${projectId}-${activityId}`;
}

/** Said in front of a name, not part of it. */
const TITLES = new Set(["frau", "herr", "dr", "prof"]);

function entityWords(
  name: string,
  aliases: readonly string[] | undefined,
  team: ReadonlySet<string>,
  profile: Profile,
): EntityWords {
  const nameWords = normalizeWords(name);
  const called = [
    ...(aliases ?? []),
    ...profile.aliases,
    ...profile.contacts.flatMap(contactNames),
  ];
  return {
    words: [...new Set(nameWords.flatMap(wordVariants))],
    // A colleague is never a customer's contact or alias, wherever the word
    // came from (learned before the team list existed, or typed in Kimai).
    aliases: [...new Set(called.flatMap(normalizeWords))].filter(
      (alias) => alias.length > 1 && !team.has(alias) && !TITLES.has(alias),
    ),
    topics: [...new Set(profile.topics.flatMap(normalizeWords))].filter(
      (topic) => topic.length > 2,
    ),
    acronym: nameWords.length > 1 ? nameWords.map((word) => word[0]).join("") : "",
  };
}

function colorOf(entity: { color?: string | null; "color-safe"?: string }): string {
  return entity.color || entity["color-safe"] || "";
}

/**
 * Every valid combination of customer × project × activity: visible projects
 * of visible customers, each with the global activities (unless the project
 * switches them off) and its own activities.
 */
export function buildCatalog(
  customers: readonly CatalogCustomer[],
  projects: readonly CatalogProject[],
  activities: readonly CatalogActivity[],
  aliases?: ConnectionAliases,
  teamMembers: readonly string[] = [],
): QuickCatalog {
  const team = new Set(teamMembers.flatMap(normalizeWords));
  const visible = <T extends { visible?: boolean }>(items: readonly T[]) =>
    items.filter((item) => item.visible !== false);
  const customerById = new Map(visible(customers).map((customer) => [customer.id, customer]));
  const visibleActivities = visible(activities);
  const globalActivities = visibleActivities.filter((activity) => activity.project === null);

  const combinations: Combination[] = [];
  const usedProjects = new Map<number, CatalogProject>();
  const usedActivities = new Map<number, CatalogActivity>();
  const usedCustomers = new Map<number, CatalogCustomer>();

  for (const project of visible(projects)) {
    const customer = customerById.get(project.customer);
    if (!customer) continue;
    const own = visibleActivities.filter((activity) => activity.project === project.id);
    const available =
      project.globalActivities === false ? own : [...own, ...globalActivities];
    if (available.length === 0) continue;
    usedProjects.set(project.id, project);
    usedCustomers.set(customer.id, customer);
    for (const activity of available) {
      usedActivities.set(activity.id, activity);
      combinations.push({
        key: combinationKey(project.id, activity.id),
        customerId: customer.id,
        customer: customer.name,
        customerColor: colorOf(customer),
        projectId: project.id,
        project: project.name,
        activityId: activity.id,
        activity: activity.name,
        activityColor: colorOf(activity),
      });
    }
  }

  const wordsOf = <T extends { id: number; name: string; comment?: string | null }>(
    entities: ReadonlyMap<number, T>,
    kind: keyof ConnectionAliases,
  ) =>
    new Map(
      [...entities.values()].map((entity) => [
        entity.id,
        entityWords(
          entity.name,
          aliases?.[kind][String(entity.id)],
          team,
          parseProfile(entity.comment),
        ),
      ]),
    );

  return {
    combinations,
    customers: wordsOf(usedCustomers, "customers"),
    projects: wordsOf(usedProjects, "projects"),
    activities: wordsOf(usedActivities, "activities"),
    team,
    profiles: new Map(
      [...usedCustomers.values()].map((customer) => [customer.id, parseProfile(customer.comment)]),
    ),
  };
}
