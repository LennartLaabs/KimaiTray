import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { getActivities } from "../../api/activityApi";
import type { KimaiClient } from "../../api/kimaiClient";
import type { KimaiCustomer } from "../../api/kimaiTypes";
import { getCustomers, getProjects } from "../../api/projectApi";
import type { ConnectionAliases } from "../settings/adversumSettings";
import { buildCatalog, type QuickCatalog } from "./catalog";
import { buildHistory, EMPTY_HISTORY, type HistoryEntry, type QuickHistory } from "./history";
import { fetchHistory } from "./quickApi";

const ENTITY_STALE_TIME = 5 * 60 * 1000;
/**
 * Customers, projects and activities are read again every five minutes: a
 * new customer, or a profile a colleague wrote into Kimai, shows up by itself.
 */
const ENTITY_REFRESH_INTERVAL = 5 * 60 * 1000;
const NO_CUSTOMERS: readonly KimaiCustomer[] = [];
const NO_ENTRIES: readonly HistoryEntry[] = [];
const HISTORY_STALE_TIME = 10 * 60 * 1000;
/** Windows live as long as the app, so the history is refreshed on a timer. */
const HISTORY_REFRESH_INTERVAL = 30 * 60 * 1000;

interface QuickEntryData {
  catalog: QuickCatalog;
  history: QuickHistory;
  /** Customers, projects and activities are loaded. */
  ready: boolean;
  /** The customers as Kimai lists them; empty while loading. */
  customers: readonly KimaiCustomer[];
  /** The entries the history was built from, with their notes. */
  entries: readonly HistoryEntry[];
}

/**
 * Everything the parser needs for one connection. Projects, customers and
 * activities share their React Query keys with upstream's `useEntityLookup`.
 * The history is optional: without it suggestions are ranked by text only.
 */
export function useQuickEntryData(
  client: KimaiClient | null,
  enabled: boolean,
  aliases: ConnectionAliases | undefined,
  teamMembers: readonly string[] = [],
): QuickEntryData {
  const active = enabled && !!client;
  const scope = client?.cacheScope;
  const projectsQ = useQuery({
    queryKey: ["projects", scope],
    queryFn: () => getProjects(client!),
    enabled: active,
    staleTime: ENTITY_STALE_TIME,
    refetchInterval: ENTITY_REFRESH_INTERVAL,
  });
  const customersQ = useQuery({
    queryKey: ["customers", scope],
    queryFn: () => getCustomers(client!),
    enabled: active,
    staleTime: ENTITY_STALE_TIME,
    refetchInterval: ENTITY_REFRESH_INTERVAL,
  });
  const activitiesQ = useQuery({
    queryKey: ["activities", scope],
    queryFn: () => getActivities(client!),
    enabled: active,
    staleTime: ENTITY_STALE_TIME,
    refetchInterval: ENTITY_REFRESH_INTERVAL,
  });
  const historyQ = useQuery({
    queryKey: ["adversum-history", scope],
    queryFn: () => fetchHistory(client!, new Date()),
    enabled: active,
    staleTime: HISTORY_STALE_TIME,
    refetchInterval: HISTORY_REFRESH_INTERVAL,
    retry: 1,
  });

  const catalog = useMemo(
    () =>
      buildCatalog(
        customersQ.data ?? [],
        projectsQ.data ?? [],
        activitiesQ.data ?? [],
        aliases,
        teamMembers,
      ),
    [customersQ.data, projectsQ.data, activitiesQ.data, aliases, teamMembers],
  );
  const history = useMemo(
    () => (historyQ.data ? buildHistory(historyQ.data, new Date()) : EMPTY_HISTORY),
    [historyQ.data],
  );

  return {
    catalog,
    history,
    ready: customersQ.isSuccess && projectsQ.isSuccess && activitiesQ.isSuccess,
    customers: customersQ.data ?? NO_CUSTOMERS,
    entries: historyQ.data ?? NO_ENTRIES,
  };
}
