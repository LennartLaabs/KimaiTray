import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KimaiClient } from "../../api/kimaiClient";
import { logger } from "../../utils/logger";
import { getCustomerHomepage } from "./customerHomepage";
import {
  fetchLogo,
  listLogos,
  onLogoChange,
  type LogoEntry,
} from "./logoApi";

interface UseCustomerLogosOptions {
  client: KimaiClient | null;
  connectionId: string;
  /** Customers whose logos should be available. */
  customerIds: readonly number[];
  logoDevToken: string;
  /**
   * Fetch missing and expired logos in the background. Only the tray window
   * does this, so two windows never fetch the same logo.
   */
  autoFetch: boolean;
}

interface UseCustomerLogosResult {
  /** Cached entries of the current connection, by customer id. */
  entries: ReadonlyMap<number, LogoEntry>;
  /** Fetch one customer's logo again, ignoring the cache. */
  reload: (customerId: number) => Promise<void>;
  /** Record an entry this window just changed itself (manual logo set or cleared). */
  apply: (customerId: number, entry: LogoEntry | null) => void;
}

/** Whether a customer's logo should be (re)fetched. */
export function needsLogoFetch(
  entry: LogoEntry | undefined,
  hasLogoDevToken: boolean,
): boolean {
  if (!entry) return true;
  if (entry.source === "manual") return false;
  return entry.stale || (hasLogoDevToken && !entry.triedLogoDev);
}

export function useCustomerLogos({
  client,
  connectionId,
  customerIds,
  logoDevToken,
  autoFetch,
}: UseCustomerLogosOptions): UseCustomerLogosResult {
  const [loaded, setLoaded] = useState<{
    connectionId: string;
    entries: ReadonlyMap<number, LogoEntry>;
  } | null>(null);
  const connectionRef = useRef(connectionId);
  connectionRef.current = connectionId;
  // One attempt per customer and logo.dev key per session: a customer without
  // a logo must not be fetched again on every render, while a corrected key
  // gets a fresh try.
  const attemptedRef = useRef(new Set<string>());

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
    async (operationClient: KimaiClient, customerId: number, force: boolean) => {
      const homepage = await getCustomerHomepage(operationClient, customerId);
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
    if (!autoFetch || !client || !entriesReady || !known || !customerKey) return;
    if (client.connectionId !== connectionId) return;
    const hasToken = logoDevToken !== "";
    const pending = customerKey
      .split(",")
      .map(Number)
      .filter((customerId) => {
        if (attemptedRef.current.has(attemptKey(client, customerId, logoDevToken))) {
          return false;
        }
        return needsLogoFetch(known.get(customerId), hasToken);
      });
    if (pending.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const customerId of pending) {
        if (cancelled || connectionRef.current !== connectionId) return;
        attemptedRef.current.add(attemptKey(client, customerId, logoDevToken));
        try {
          await fetchOne(client, customerId, false);
        } catch (error) {
          logger.debug(`Logo fetch failed for customer ${customerId}: ${String(error)}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [autoFetch, client, connectionId, customerKey, logoDevToken, entriesReady, fetchOne]);

  const reload = useCallback(
    async (customerId: number) => {
      if (!client) return;
      await fetchOne(client, customerId, true);
    },
    [client, fetchOne],
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

function attemptKey(client: KimaiClient, customerId: number, token: string): string {
  return `${client.cacheScope}:${customerId}:${token}`;
}

const EMPTY_ENTRIES: ReadonlyMap<number, LogoEntry> = new Map();
