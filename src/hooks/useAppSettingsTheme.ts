import { useEffect, useState } from "react";

import { fetchAppSettings, saveAppSettings, type AppSettings } from "../lib/api";

export function useAppSettingsTheme() {
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [isSavingTheme, setIsSavingTheme] = useState(false);
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    let cancelled = false;

    fetchAppSettings()
      .then((settings) => {
        if (!cancelled) {
          setAppSettings(settings);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setSettingsError(error instanceof Error ? error.message : "Settings could not be loaded.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setSettingsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const applyTheme = () => {
      const override = appSettings?.theme_override ?? "light";
      const nextResolvedTheme: "light" | "dark" =
        override === "dark" ? "dark" : "light";
      root.dataset.theme = nextResolvedTheme;
      root.style.colorScheme = nextResolvedTheme;
      setResolvedTheme(nextResolvedTheme);
    };

    applyTheme();
  }, [appSettings?.theme_override]);

  async function handleSetTheme(nextTheme: "light" | "dark") {
    if (!appSettings || isSavingTheme) {
      return;
    }
    if (resolvedTheme === nextTheme && appSettings.theme_override === nextTheme) {
      return;
    }

    setIsSavingTheme(true);
    setSettingsError(null);
    try {
      const saved = await saveAppSettings({ theme_override: nextTheme });
      setAppSettings(saved);
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : "Theme could not be updated.");
    } finally {
      setIsSavingTheme(false);
    }
  }

  return {
    appSettings,
    setAppSettings,
    settingsLoading,
    settingsError,
    setSettingsError,
    isSavingTheme,
    resolvedTheme,
    handleSetTheme
  };
}
