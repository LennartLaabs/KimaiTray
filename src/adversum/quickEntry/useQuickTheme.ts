import { useEffect } from "react";
import { loadSettings, onSettingsChange } from "../../settings/service";
import type { AppSettings } from "../../types";

/**
 * Light or dark and the accent color for the quick entry window. Upstream's
 * `useAppearance` is not used there, because it also resizes the tray popup.
 */
export function useQuickTheme(): void {
  useEffect(() => {
    let active = true;
    const apply = (settings: AppSettings) => {
      if (!active) return;
      const root = document.documentElement;
      root.dataset.accent = settings.accentStyle;
      root.classList.toggle(
        "dark",
        settings.theme === "dark" ||
          (settings.theme === "transparent" &&
            window.matchMedia("(prefers-color-scheme: dark)").matches),
      );
    };
    void loadSettings().then(apply);
    const unlisten = onSettingsChange(apply);
    unlisten.catch(() => undefined);
    return () => {
      active = false;
      void unlisten.then((cleanup) => cleanup()).catch(() => undefined);
    };
  }, []);
}
