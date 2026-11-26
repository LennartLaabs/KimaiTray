import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { KimaiClient } from "../../api/kimaiClient";
import { lookupCustomerHomepage, type HomepageLookup } from "./customerHomepage";

/** Homepages are read again when the popup opens, at most once a minute. */
const HOMEPAGE_STALE_TIME = 60 * 1000;
/** While the app just sits in the tray they are read every five minutes. */
const HOMEPAGE_REFRESH_INTERVAL = 5 * 60 * 1000;
const PARALLEL_LOOKUPS = 4;

export type HomepageLookups = ReadonlyMap<number, HomepageLookup>;

interface UseCustomerHomepagesResult {
  /** Lookups by customer id; `undefined` until the first round has finished. */
  lookups: HomepageLookups | undefined;
  /** Time of the last completed round, to re-evaluate cached logos against. */
  updatedAt: number;
  /** Reads the homepages again unless that happened within the last minute. */
  refreshIfStale: () => void;
  /** Records a lookup made elsewhere (a single customer's "reload"). */
  remember: (customerId: number, lookup: HomepageLookup) => void;
}

async function lookupAll(
  client: KimaiClient,
  customerIds: readonly number[],
): Promise<HomepageLookups> {
  const lookups = new Map<number, HomepageLookup>();
  const queue = [...customerIds];
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      lookups.set(id, await lookupCustomerHomepage(client, id));
    }
  };
  await Promise.all(Array.from({ length: PARALLEL_LOOKUPS }, worker));
  return lookups;
}

/**
 * The current homepage of every customer, straight from Kimai. This is what
 * lets a homepage entered or changed in Kimai take effect without waiting for
 * a cached logo result to expire.
 */
export function useCustomerHomepages(
  client: KimaiClient | null,
  enabled: boolean,
  customerIds: readonly number[],
): UseCustomerHomepagesResult {
  const qc = useQueryClient();
  const idsKey = useMemo(
    () => [...new Set(customerIds)].sort((a, b) => a - b).join(","),
    [customerIds],
  );
  const queryKey = useMemo(
    () => ["adversum-customer-homepages", client?.cacheScope, idsKey] as const,
    [client?.cacheScope, idsKey],
  );
  const query = useQuery({
    queryKey,
    queryFn: () => lookupAll(client!, idsKey.split(",").map(Number)),
    enabled: enabled && !!client && idsKey !== "",
    staleTime: HOMEPAGE_STALE_TIME,
    refetchInterval: HOMEPAGE_REFRESH_INTERVAL,
  });
  const { isStale, refetch } = query;

  const refreshIfStale = useCallback(() => {
    if (isStale) void refetch();
  }, [isStale, refetch]);

  const remember = useCallback(
    (customerId: number, lookup: HomepageLookup) => {
      qc.setQueryData<HomepageLookups>(queryKey, (current) =>
        current ? new Map(current).set(customerId, lookup) : current,
      );
    },
    [qc, queryKey],
  );

  return {
    lookups: query.data,
    updatedAt: query.dataUpdatedAt,
    refreshIfStale,
    remember,
  };
}
