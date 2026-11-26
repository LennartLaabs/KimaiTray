import { useContext, type ReactNode } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import CustomerLogosSection from "./CustomerLogosSection";

/** Settings pages the fork adds to the settings sidebar. */
export type AdversumSection = "adversumLogos";

interface AdversumNavigation {
  icons: Record<AdversumSection, ReactNode>;
  labelKeys: Record<AdversumSection, string>;
  group: { titleKey: string; items: AdversumSection[] };
}

export const ADVERSUM_NAV: AdversumNavigation = {
  icons: {
    adversumLogos: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <circle cx="12" cy="9" r="3.25" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M5.5 19.25a6.5 6.5 0 0113 0" />
        <circle cx="12" cy="12" r="9.25" />
      </svg>
    ),
  },
  labelKeys: {
    adversumLogos: "adversum.logos.title",
  },
  group: { titleKey: "adversum.settingsGroup", items: ["adversumLogos"] },
};

/**
 * Fork pages load Kimai data through React Query. The app always provides a
 * client (`main.tsx`); upstream's settings tests render every page without
 * one, and there a fork page simply renders nothing.
 */
function WithQueryClient({ children }: { children: ReactNode }) {
  return useContext(QueryClientContext) ? children : null;
}

export function renderAdversumSection(section: AdversumSection): ReactNode {
  switch (section) {
    case "adversumLogos":
      return (
        <WithQueryClient>
          <CustomerLogosSection />
        </WithQueryClient>
      );
  }
}
