import { useContext, type ReactNode } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import CustomerLogosSection from "./CustomerLogosSection";
import QuickEntrySection from "./QuickEntrySection";
import VoiceSection from "./VoiceSection";

/** Settings pages the fork adds to the settings sidebar. */
export type AdversumSection = "adversumQuick" | "adversumVoice" | "adversumLogos";

interface AdversumNavigation {
  icons: Record<AdversumSection, ReactNode>;
  labelKeys: Record<AdversumSection, string>;
  group: { titleKey: string; items: AdversumSection[] };
}

export const ADVERSUM_NAV: AdversumNavigation = {
  icons: {
    adversumQuick: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M13 3L5 13.5h6L10 21l8-10.5h-6L13 3z" />
      </svg>
    ),
    adversumVoice: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21" />
      </svg>
    ),
    adversumLogos: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <circle cx="12" cy="9" r="3.25" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M5.5 19.25a6.5 6.5 0 0113 0" />
        <circle cx="12" cy="12" r="9.25" />
      </svg>
    ),
  },
  labelKeys: {
    adversumQuick: "adversum.quickSettings.title",
    adversumVoice: "adversum.voice.title",
    adversumLogos: "adversum.logos.title",
  },
  group: { titleKey: "adversum.settingsGroup", items: ["adversumQuick", "adversumVoice", "adversumLogos"] },
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
    case "adversumQuick":
      return (
        <WithQueryClient>
          <QuickEntrySection />
        </WithQueryClient>
      );
    case "adversumVoice":
      return (
        <WithQueryClient>
          <VoiceSection />
        </WithQueryClient>
      );
    case "adversumLogos":
      return (
        <WithQueryClient>
          <CustomerLogosSection />
        </WithQueryClient>
      );
  }
}
