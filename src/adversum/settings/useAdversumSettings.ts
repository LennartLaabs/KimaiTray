import { useCallback, useEffect, useRef, useState } from "react";
import { logger } from "../../utils/logger";
import {
  defaultAdversumSettings,
  loadAdversumSettings,
  onAdversumSettingsChange,
  patchAdversumSettings,
  type AdversumSettings,
} from "./adversumSettings";

interface UseAdversumSettingsResult {
  settings: AdversumSettings;
  loaded: boolean;
  /** Applies the value immediately and persists it; reverts when saving fails. */
  update: <K extends keyof AdversumSettings>(
    key: K,
    value: AdversumSettings[K],
  ) => Promise<void>;
}

/** Fork settings for one window, kept in step with every other window. */
export function useAdversumSettings(): UseAdversumSettingsResult {
  const [settings, setSettings] = useState<AdversumSettings>(defaultAdversumSettings);
  const [loaded, setLoaded] = useState(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    let active = true;
    void loadAdversumSettings().then((next) => {
      if (!active) return;
      setSettings(next);
      setLoaded(true);
    });
    const unlisten = onAdversumSettingsChange((next) => {
      if (active) setSettings(next);
    });
    return () => {
      active = false;
      void unlisten.then((cleanup) => cleanup()).catch(() => undefined);
    };
  }, []);

  const update = useCallback(
    async <K extends keyof AdversumSettings>(key: K, value: AdversumSettings[K]) => {
      const previous = settingsRef.current;
      setSettings({ ...previous, [key]: value });
      try {
        setSettings(await patchAdversumSettings({ [key]: value }));
      } catch (error) {
        logger.error(`Failed to save Adversum setting ${key}: ${String(error)}`);
        setSettings(previous);
      }
    },
    [],
  );

  return { settings, loaded, update };
}
