import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { getActivities } from "../../api/activityApi";
import type { KimaiClient } from "../../api/kimaiClient";
import { getCustomers, getProjects } from "../../api/projectApi";
import type { ConnectionAliases } from "../settings/adversumSettings";
import { buildCatalog, type QuickCatalog } from "./catalog";
import { buildHistory, EMPTY_HISTORY, type QuickHistory } from "./history";
import { fetchHistory } from "./quickApi";

const ENTITY_STALE_TIME = 5 * 60 * 1000;
const HISTORY_STALE_TIME = 10 * 60 * 1000;
/** Windows live as long as the app, so the history is refreshed on a timer. */
const HISTORY_REFRESH_INTERVAL = 30 * 60 * 1000;

interface QuickEntryData {
  catalog: QuickCatalog;
  history: QuickHistory;
  /** Customers, projects and activities are loaded. */
  ready: boolean;
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
): QuickEntryData {
  const active = enabled && !!client;
  const scope = client?.cacheScope;
  const projectsQ = useQuery({
    queryKey: ["projects", scope],
    queryFn: () => getProjects(client!),
    enabled: active,
    staleTime: ENTITY_STALE_TIME,
  });
  const customersQ = useQuery({
    queryKey: ["customers", scope],
    queryFn: () => getCustomers(client!),
    enabled: active,
    staleTime: ENTITY_STALE_TIME,
  });
  const activitiesQ = useQuery({
    queryKey: ["activities", scope],
    queryFn: () => getActivities(client!),
    enabled: active,
    staleTime: ENTITY_STALE_TIME,
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
      ),
    [customersQ.data, projectsQ.data, activitiesQ.data, aliases],
  );
  const history = useMemo(
    () => (historyQ.data ? buildHistory(historyQ.data, new Date()) : EMPTY_HISTORY),
    [historyQ.data],
  );

  return {
    catalog,
    history,
    ready: customersQ.isSuccess && projectsQ.isSuccess && activitiesQ.isSuccess,
  };
}
