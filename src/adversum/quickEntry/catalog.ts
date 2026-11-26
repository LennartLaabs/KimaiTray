import type { ConnectionAliases } from "../settings/adversumSettings";
import { normalizeWords, wordVariants } from "./normalize";

/** The Kimai entities the quick entry bar needs; a subset of the API types. */
export interface CatalogCustomer {
  id: number;
  name: string;
  visible?: boolean;
  color?: string | null;
  "color-safe"?: string;
}
export interface CatalogProject {
  id: number;
  name: string;
  customer: number;
  visible?: boolean;
  globalActivities?: boolean;
}
export interface CatalogActivity {
  id: number;
  name: string;
  project: number | null;
  visible?: boolean;
  color?: string | null;
  "color-safe"?: string;
}

/** The words an entity can be addressed by, already normalized. */
export interface EntityWords {
  /** Words of the name, including short umlaut spellings. */
  words: string[];
  /** Words of the user's aliases for this entity. */
  aliases: string[];
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
}

export function combinationKey(projectId: number, activityId: number): string {
  return `${projectId}-${activityId}`;
}

function entityWords(
  name: string,
  aliases: readonly string[] | undefined,
  team: ReadonlySet<string>,
): EntityWords {
  const nameWords = normalizeWords(name);
  return {
    words: [...new Set(nameWords.flatMap(wordVariants))],
    // A colleague's name that was stored as an alias (learned before the
    // team list existed) does not count.
    aliases: [...new Set((aliases ?? []).flatMap(normalizeWords))].filter(
      (alias) => !team.has(alias),
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

  const wordsOf = <T extends { id: number; name: string }>(
    entities: ReadonlyMap<number, T>,
    kind: keyof ConnectionAliases,
  ) =>
    new Map(
      [...entities.values()].map((entity) => [
        entity.id,
        entityWords(entity.name, aliases?.[kind][String(entity.id)], team),
      ]),
    );

  return {
    combinations,
    customers: wordsOf(usedCustomers, "customers"),
    projects: wordsOf(usedProjects, "projects"),
    activities: wordsOf(usedActivities, "activities"),
    team,
  };
}
