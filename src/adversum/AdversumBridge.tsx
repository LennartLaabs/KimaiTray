import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { getCustomers, getProjects } from "../api/projectApi";
import { useKimaiClient } from "../hooks/useKimaiClient";
import {
  setAdversumDisplay,
  type DisplayCustomer,
} from "./display/displayStore";
import { useCustomerLogos } from "./logos/useCustomerLogos";
import { useAdversumSettings } from "./settings/useAdversumSettings";

const ENTITY_STALE_TIME = 5 * 60 * 1000;

interface AdversumBridgeProps {
  /** Tauri label of the window this bridge runs in. */
  windowLabel: string;
}

/**
 * Feeds the fork's display store for one window. It is mounted next to the
 * window component in `main.tsx` and renders nothing.
 *
 * Projects and customers use the same React Query keys as upstream's
 * `useEntityLookup`, so both share one cached request.
 */
export default function AdversumBridge({ windowLabel }: AdversumBridgeProps) {
  const { client, isConfigured, activeConnectionId } = useKimaiClient();
  const { settings, loaded } = useAdversumSettings();
  const enabled = !!client && isConfigured;

  const projectsQ = useQuery({
    queryKey: ["projects", client?.cacheScope],
    queryFn: () => getProjects(client!),
    enabled,
    staleTime: ENTITY_STALE_TIME,
  });
  const customersQ = useQuery({
    queryKey: ["customers", client?.cacheScope],
    queryFn: () => getCustomers(client!),
    enabled,
    staleTime: ENTITY_STALE_TIME,
  });

  const customerIds = useMemo(
    () => (customersQ.data ?? []).map((customer) => customer.id),
    [customersQ.data],
  );
  const { entries } = useCustomerLogos({
    client,
    connectionId: activeConnectionId,
    customerIds,
    logoDevToken: settings.logoDevToken,
    // Only the long-lived tray window fetches; other windows read the cache.
    autoFetch: windowLabel === "tray-popup" && settings.customerIndicator === "logo",
  });

  const customersByProject = useMemo(() => {
    const customers = new Map<number, DisplayCustomer>(
      (customersQ.data ?? []).map((customer) => [
        customer.id,
        {
          id: customer.id,
          name: customer.name,
          color: customer.color || customer["color-safe"] || "",
        },
      ]),
    );
    const byProject = new Map<number, DisplayCustomer>();
    for (const project of projectsQ.data ?? []) {
      const customer = customers.get(project.customer);
      if (customer) byProject.set(project.id, customer);
    }
    return byProject;
  }, [customersQ.data, projectsQ.data]);

  const logos = useMemo(() => {
    const urls = new Map<number, string>();
    for (const entry of entries.values()) {
      if (entry.dataUrl) urls.set(entry.customerId, entry.dataUrl);
    }
    return urls;
  }, [entries]);

  useEffect(() => {
    if (!loaded) return;
    setAdversumDisplay({
      indicator: settings.customerIndicator,
      customersByProject,
      logos,
    });
  }, [loaded, settings.customerIndicator, customersByProject, logos]);

  useEffect(() => () => setAdversumDisplay(null), []);

  return null;
}
