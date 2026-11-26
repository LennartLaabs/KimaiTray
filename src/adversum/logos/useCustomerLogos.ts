import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KimaiClient } from "../../api/kimaiClient";
import { logger } from "../../utils/logger";
import { lookupCustomerHomepage, type HomepageLookup } from "./customerHomepage";
import {
  fetchLogo,
  listLogos,
  onLogoChange,
  type LogoEntry,
} from "./logoApi";
import type { HomepageLookups } from "./useCustomerHomepages";

/** A lookup that just failed is not repeated for the same input this soon. */
const RETRY_PAUSE_MS = 10 * 60 * 1000;

interface UseCustomerLogosOptions {
  client: KimaiClient | null;
  connectionId: string;
  /** Customers whose logos should be available. */
  customerIds: readonly number[];
  logoDevToken: string;
  /**
   * Fetch missing, expired and outdated logos in the background. Only the
   * tray window does this, so two windows never fetch the same logo.
   */
  autoFetch: boolean;
  /** Current homepages from Kimai; background fetching waits for them. */
  homepages?: HomepageLookups;
  /** Changes whenever the homepages were read again. */
  homepagesUpdatedAt?: number;
  /** Told about the homepage read during a single customer's reload. */
  onHomepageLookup?: (customerId: number, lookup: HomepageLookup) => void;
}

interface UseCustomerLogosResult {
  /** Cached entries of the current connection, by customer id. */
  entries: ReadonlyMap<number, LogoEntry>;
  /**
   * Reads the customer's homepage from Kimai and fetches the logo again,
   * ignoring the cache. Rejects when Kimai could not be asked.
   */
  reload: (customerId: number) => Promise<void>;
  /** Record an entry this window just changed itself (manual logo set or cleared). */
  apply: (customerId: number, entry: LogoEntry | null) => void;
}

/**
 * Whether a customer's logo should be (re)fetched: nothing cached yet, the
 * homepage in Kimai differs from the one the cached result belongs to, the
 * result expired, or a logo.dev key arrived that was never tried.
 */
export function needsLogoFetch(
  entry: LogoEntry | undefined,
  homepage: string | null,
  hasLogoDevToken: boolean,
  nowSeconds: number,
): boolean {
  if (!entry) return true;
  if (entry.source === "manual") return false;
  if (entry.homepage !== homepage) return true;
  if (entry.expiresAt !== null && nowSeconds >= entry.expiresAt) return true;
  return hasLogoDevToken && !entry.triedLogoDev;
}

export function useCustomerLogos({
  client,
  connectionId,
  customerIds,
  logoDevToken,
  autoFetch,
  homepages,
  homepagesUpdatedAt = 0,
  onHomepageLookup,
}: UseCustomerLogosOptions): UseCustomerLogosResult {
  const [loaded, setLoaded] = useState<{
    connectionId: string;
    entries: ReadonlyMap<number, LogoEntry>;
  } | null>(null);
  const connectionRef = useRef(connectionId);
  connectionRef.current = connectionId;
  // When each lookup was last attempted, by customer, logo.dev key and
  // homepage. A lookup that keeps failing is not repeated on every render,
  // while a new key or a changed homepage is tried at once.
  const attemptsRef = useRef(new Map<string, number>());

  const mergeEntry = useCallback(
    (forConnection: string, customerId: number, entry: LogoEntry | null) => {
      setLoaded((current) => {
        if (!current || current.connectionId !== forConnection) return current;
        const entries = new Map(current.entries);
        if (entry) entries.set(customerId, entry);
        else entries.delete(customerId);
        return { connectionId: forConnection, entries };
      });
    },
    [],
  );

  useEffect(() => {
    setLoaded(null);
    if (!connectionId) return;
    let active = true;
    listLogos(connectionId)
      .then((list) => {
        if (!active) return;
        setLoaded({
          connectionId,
          entries: new Map((list ?? []).map((entry) => [entry.customerId, entry])),
        });
      })
      .catch((error) => {
        if (!active) return;
        logger.error(`Failed to load cached logos: ${String(error)}`);
        setLoaded({ connectionId, entries: new Map() });
      });
    return () => {
      active = false;
    };
  }, [connectionId]);

  useEffect(() => {
    const unlisten = onLogoChange((change) => {
      mergeEntry(change.connectionId, change.customerId, change.entry);
    });
    unlisten.catch(() => undefined);
    return () => {
      void unlisten.then((cleanup) => cleanup()).catch(() => undefined);
    };
  }, [mergeEntry]);

  const fetchOne = useCallback(
    async (
      operationClient: KimaiClient,
      customerId: number,
      homepage: string | null,
      force: boolean,
    ) => {
      const entry = await fetchLogo({
        connectionId: operationClient.connectionId,
        customerId,
        homepage,
        logoDevToken: logoDevToken || null,
        force,
      });
      mergeEntry(operationClient.connectionId, customerId, entry);
    },
    [logoDevToken, mergeEntry],
  );

  const entries = loaded?.connectionId === connectionId ? loaded.entries : null;
  const entriesReady = entries !== null;
  // The queue reads the entries current when it starts. Every fetched logo
  // updates them, and restarting the queue for each one would only re-filter
  // the same list.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const customerKey = useMemo(
    () => [...new Set(customerIds)].sort((a, b) => a - b).join(","),
    [customerIds],
  );

  useEffect(() => {
    const known = entriesRef.current;
    if (!autoFetch || !client || !entriesReady || !known || !homepages || !customerKey) return;
    if (client.connectionId !== connectionId) return;
    const hasToken = logoDevToken !== "";
    const now = Date.now();
    const pending: { customerId: number; homepage: string | null; attempt: string }[] = [];
    for (const customerId of customerKey.split(",").map(Number)) {
      const lookup = homepages.get(customerId);
      // Without a readable homepage nothing new can be learned.
      if (!lookup || lookup.failed) continue;
      if (!needsLogoFetch(known.get(customerId), lookup.homepage, hasToken, now / 1000)) continue;
      const attempt = attemptKey(client, customerId, logoDevToken, lookup.homepage);
      const attemptedAt = attemptsRef.current.get(attempt);
      if (attemptedAt !== undefined && now - attemptedAt < RETRY_PAUSE_MS) continue;
      pending.push({ customerId, homepage: lookup.homepage, attempt });
    }
    if (pending.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const { customerId, homepage, attempt } of pending) {
        if (cancelled || connectionRef.current !== connectionId) return;
        attemptsRef.current.set(attempt, Date.now());
        try {
          await fetchOne(client, customerId, homepage, false);
        } catch (error) {
          logger.debug(`Logo fetch failed for customer ${customerId}: ${String(error)}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    autoFetch,
    client,
    connectionId,
    customerKey,
    logoDevToken,
    entriesReady,
    homepages,
    homepagesUpdatedAt,
    fetchOne,
  ]);

  const reload = useCallback(
    async (customerId: number) => {
      if (!client) return;
      const lookup = await lookupCustomerHomepage(client, customerId);
      onHomepageLookup?.(customerId, lookup);
      if (lookup.failed) throw new Error("The homepage could not be read from Kimai");
      await fetchOne(client, customerId, lookup.homepage, true);
    },
    [client, fetchOne, onHomepageLookup],
  );

  const apply = useCallback(
    (customerId: number, entry: LogoEntry | null) => {
      mergeEntry(connectionId, customerId, entry);
    },
    [connectionId, mergeEntry],
  );

  return {
    entries: entries ?? EMPTY_ENTRIES,
    reload,
    apply,
  };
}

function attemptKey(
  client: KimaiClient,
  customerId: number,
  token: string,
  homepage: string | null,
): string {
  return JSON.stringify([client.cacheScope, customerId, token, homepage]);
}

const EMPTY_ENTRIES: ReadonlyMap<number, LogoEntry> = new Map();
