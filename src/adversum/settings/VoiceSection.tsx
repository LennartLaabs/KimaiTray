import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { usePlatform } from "../../platform";
import { Select, Toggle, buttonClass } from "../../settings/Controls";
import {
  RadioDot,
  SettingsList,
  SettingsNote,
  SettingsPage,
  SettingsRow,
  SettingsWarning,
} from "../../settings/SettingsLayout";
import {
  cancelVoiceDownload,
  chooseVoiceModelDir,
  deleteVoiceModel,
  downloadVoiceModel,
  getVoiceDevices,
  getVoiceStatus,
  openVoicePrivacySettings,
  requestVoicePermission,
  VOICE_DOWNLOAD_EVENT,
  VOICE_PERMISSION_EVENT,
  type VoiceDevice,
  type VoiceDownload,
  type VoiceStatus,
  reloadModelInternally,
} from "../voice/voiceApi";
import AcceleratorInput from "./AcceleratorInput";
import BrainSection from "./BrainSection";
import { formatSize } from "./formatSize";
import MicrophoneTest from "./MicrophoneTest";
import type { VoiceModel } from "./adversumSettings";
import { useAdversumSettings } from "./useAdversumSettings";

type Problem = "download" | "folder" | "shortcut";

export { formatSize };

function ignore(): void {
  // Outcomes arrive as events or through the next status read.
}

/**
 * Settings page "Voice input": switch it on, microphone permission, speech
 * model (download, delete, where to store it) and how recording is triggered.
 */
export default function VoiceSection() {
  const { t } = useTranslation();
  const platform = usePlatform();
  const { settings, update } = useAdversumSettings();
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [devices, setDevices] = useState<VoiceDevice[]>([]);
  const [download, setDownload] = useState<VoiceDownload | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);

  const chosen = useRef(settings.voiceModel);
  chosen.current = settings.voiceModel;
  const updateRef = useRef(update);
  updateRef.current = update;

  const refresh = useCallback(async () => {
    try {
      const next = await getVoiceStatus();
      setStatus(next);
      setDownload(next.download);
      // The choice follows the files: when the chosen model is gone (deleted,
      // or another one was downloaded instead) and nothing is being loaded,
      // the one voice input really uses becomes the chosen one.
      const missing = !next.models.some((model) => model.id === chosen.current && model.installed);
      if (missing && next.activeModel && !next.download) {
        void updateRef.current("voiceModel", next.activeModel);
      }
    } catch {
      setStatus(null);
    }
    // A microphone may have been plugged in or pulled meanwhile.
    setDevices(await getVoiceDevices().catch(() => []));
  }, []);

  // Also after the folder changed, and when the user comes back from the
  // system settings, where the microphone permission may have changed.
  useEffect(() => {
    void refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh, settings.voiceModelDir]);

  useEffect(() => {
    const listeners = [
      listen<VoiceDownload>(VOICE_DOWNLOAD_EVENT, ({ payload }) => {
        if (payload.state === "progress") {
          setDownload(payload);
          return;
        }
        if (payload.state === "failed") setProblem("download");
        void refresh();
      }),
      listen(VOICE_PERMISSION_EVENT, () => void refresh()),
    ];
    return () => {
      for (const listener of listeners) {
        void listener.then((unlisten) => unlisten()).catch(ignore);
      }
    };
  }, [refresh]);

  if (!status) {
    return (
      <SettingsPage
        title={t("adversum.voice.title")}
        description={t("adversum.voice.description")}
      >
        {null}
      </SettingsPage>
    );
  }
  if (!status.supported) {
    return (
      <SettingsPage
        title={t("adversum.voice.title")}
        description={t("adversum.voice.description")}
      >
        <SettingsNote>{t("adversum.voice.settings.unsupported")}</SettingsNote>
      </SettingsPage>
    );
  }

  const installed = (model: VoiceModel) =>
    status.models.some((item) => item.id === model && item.installed);

  const startDownload = (model: VoiceModel) => {
    setProblem(null);
    setDownload({ model, state: "progress", received: 0, total: 0 });
    void downloadVoiceModel(model).catch(ignore);
  };

  const enable = async (enabled: boolean) => {
    if (!(await update("voiceEnabled", enabled)) || !enabled) return;
    if (status.permission === "undetermined") void requestVoicePermission().catch(ignore);
    if (!installed(settings.voiceModel) && !download) startDownload(settings.voiceModel);
  };

  const selectModel = (model: VoiceModel) => {
    void update("voiceModel", model);
    if (settings.voiceEnabled && !installed(model) && !download) startDownload(model);
  };

  const remove = async (model: VoiceModel) => {
    await deleteVoiceModel(model).catch(ignore);
    await refresh();
  };

  const chooseFolder = async () => {
    setProblem(null);
    const folder = await chooseVoiceModelDir().catch(() => null);
    if (folder && !(await update("voiceModelDir", folder))) setProblem("folder");
  };

  const saveShortcut = async (accelerator: string) => {
    setProblem(null);
    if (!(await update("shortcutVoice", accelerator))) setProblem("shortcut");
  };

  const deviceOptions = [
    { value: "", label: t("adversum.voice.settings.systemInput") },
    ...devices.map((device) => ({
      value: device.id,
      label: device.isDefault
        ? t("adversum.voice.settings.deviceIsSystemInput", { name: device.name })
        : device.name,
    })),
    // A stored microphone that is not connected right now stays visible.
    ...(settings.voiceInputDevice && !devices.some((device) => device.id === settings.voiceInputDevice)
      ? [{ value: settings.voiceInputDevice, label: t("adversum.voice.settings.deviceMissing") }]
      : []),
  ];

  const used = status.models
    .filter((model) => model.installed)
    .reduce((sum, model) => sum + model.sizeBytes, 0);

  return (
    <SettingsPage title={t("adversum.voice.title")} description={t("adversum.voice.description")}>
      {!platform.supportsGlobalShortcuts && (
        <SettingsWarning>{t("shortcuts.waylandUnavailable")}</SettingsWarning>
      )}
      {status.modelVolume && (
        <SettingsWarning>
          <span data-voice-volume>
            {t("adversum.voice.problem.modelVolume", { volume: status.modelVolume })}
          </span>{" "}
          <button
            type="button"
            className={buttonClass("secondary", "sm")}
            disabled={!!download}
            onClick={() => {
              setProblem(null);
              void reloadModelInternally().catch(ignore);
            }}
          >
            {t("adversum.voice.useInternal")}
          </button>
        </SettingsWarning>
      )}
      <SettingsList>
        <SettingsRow
          label={t("adversum.voice.settings.enable")}
          description={t("adversum.voice.settings.enableDescription")}
        >
          <Toggle
            ariaLabel={t("adversum.voice.settings.enable")}
            checked={settings.voiceEnabled}
            onChange={(enabled) => void enable(enabled)}
          />
        </SettingsRow>
        <SettingsRow
          label={t("adversum.voice.settings.microphone")}
          description={
            <span data-voice-permission={status.permission}>
              {t(`adversum.voice.settings.permission.${status.permission}`)}
            </span>
          }
        >
          {status.permission === "undetermined" && (
            <button
              type="button"
              className={buttonClass()}
              onClick={() => void requestVoicePermission().then(refresh).catch(ignore)}
            >
              {t("adversum.voice.settings.requestPermission")}
            </button>
          )}
          {status.permission === "denied" && (
            <button
              type="button"
              className={buttonClass()}
              onClick={() => void openVoicePrivacySettings().catch(ignore)}
            >
              {t("adversum.voice.openPrivacy")}
            </button>
          )}
        </SettingsRow>
      </SettingsList>

      <SettingsList title={t("adversum.voice.settings.microphone")}>
        <SettingsRow
          label={t("adversum.voice.settings.device")}
          description={t("adversum.voice.settings.deviceDescription")}
        >
          <div className="w-[230px]">
            <Select
              ariaLabel={t("adversum.voice.settings.device")}
              value={settings.voiceInputDevice}
              onChange={(device) => void update("voiceInputDevice", device)}
              options={deviceOptions}
            />
          </div>
        </SettingsRow>
        <MicrophoneTest />
        <SettingsRow
          label={t("adversum.voice.settings.debug")}
          description={
            <>
              {t("adversum.voice.settings.debugDescription")}
              <span data-voice-debug-dir className="block break-all font-mono text-[11px]">
                {status.debugDir}
              </span>
            </>
          }
        >
          <Toggle
            ariaLabel={t("adversum.voice.settings.debug")}
            checked={settings.voiceDebug}
            onChange={(debug) => void update("voiceDebug", debug)}
          />
        </SettingsRow>
      </SettingsList>

      <SettingsList
        title={t("adversum.voice.settings.model")}
        description={t("adversum.voice.settings.modelDescription")}
      >
        <div role="radiogroup" aria-label={t("adversum.voice.settings.model")}>
          {status.models.map((model) => {
            const name = t(`adversum.voice.settings.models.${model.id}.name`);
            const loading = download?.model === model.id ? download : null;
            const percent =
              loading && loading.total > 0
                ? Math.floor((loading.received / loading.total) * 100)
                : 0;
            return (
              <div
                key={model.id}
                data-settings-item
                data-voice-model={model.id}
                className="border-b border-[var(--s-line-soft)] px-4 py-3 last:border-b-0"
              >
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={settings.voiceModel === model.id}
                    onClick={() => selectModel(model.id)}
                    className="flex min-w-0 flex-1 items-center gap-3 rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  >
                    <RadioDot active={settings.voiceModel === model.id} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium text-[var(--s-fg)]">
                        {name} · {formatSize(model.sizeBytes)}
                      </span>
                      <span className="block text-[11.5px] text-[var(--s-fg-subtle)]">
                        {t(`adversum.voice.settings.models.${model.id}.note`)}
                      </span>
                    </span>
                  </button>
                  {loading ? (
                    <>
                      <span role="status" className="text-[11.5px] tabular-nums text-[var(--s-fg-muted)]">
                        {t("adversum.voice.settings.downloading", { percent: String(percent) })}
                      </span>
                      <button
                        type="button"
                        className={buttonClass("ghost", "sm")}
                        onClick={() => void cancelVoiceDownload().catch(ignore)}
                      >
                        {t("adversum.voice.settings.cancel")}
                      </button>
                    </>
                  ) : model.installed ? (
                    <>
                      <span className="text-[11.5px] text-emerald-600 dark:text-emerald-400">
                        {t("adversum.voice.settings.installed")}
                      </span>
                      <button
                        type="button"
                        aria-label={t("adversum.voice.settings.deleteLabel", { name })}
                        className={buttonClass("ghost", "sm")}
                        onClick={() => void remove(model.id)}
                      >
                        {t("adversum.voice.settings.delete")}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      aria-label={t("adversum.voice.settings.downloadLabel", { name })}
                      className={buttonClass("secondary", "sm")}
                      disabled={!!download}
                      onClick={() => startDownload(model.id)}
                    >
                      {t("adversum.voice.settings.download")}
                    </button>
                  )}
                </div>
                {loading && (
                  <div className="mt-2 h-1 overflow-hidden rounded bg-[var(--s-line-soft)]">
                    <div
                      data-voice-progress
                      className="h-full bg-[var(--accent)] transition-[width]"
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {problem === "download" && (
          <p role="alert" className="px-4 py-2.5 text-[12px] text-red-500 dark:text-red-400">
            {t("adversum.voice.settings.downloadFailed")}
          </p>
        )}
        <SettingsRow
          label={t("adversum.voice.settings.folder")}
          description={
            <>
              <span data-voice-folder className="block break-all font-mono text-[11px]">
                {status.modelDir}
              </span>
              {t("adversum.voice.settings.used", { size: formatSize(used) })}{" "}
              {t("adversum.voice.settings.folderDescription")}
              {problem === "folder" && (
                <span role="alert" className="mt-1 block text-red-500 dark:text-red-400">
                  {t("adversum.voice.settings.folderRejected")}
                </span>
              )}
            </>
          }
        >
          {settings.voiceModelDir !== "" && (
            <button
              type="button"
              className={buttonClass("ghost", "sm")}
              onClick={() => void update("voiceModelDir", "")}
            >
              {t("adversum.voice.settings.resetFolder")}
            </button>
          )}
          <button
            type="button"
            className={buttonClass("secondary", "sm")}
            onClick={() => void chooseFolder()}
          >
            {t("adversum.voice.settings.chooseFolder")}
          </button>
        </SettingsRow>
      </SettingsList>

      <SettingsList title={t("adversum.voice.settings.trigger")}>
        <SettingsRow
          label={t("adversum.voice.settings.shortcut")}
          description={
            <>
              {t(
                settings.voiceTapMode
                  ? "adversum.voice.settings.shortcutTapDescription"
                  : "adversum.voice.settings.shortcutDescription",
              )}
              {problem === "shortcut" && (
                <span role="alert" className="mt-1 block text-red-500 dark:text-red-400">
                  {t("adversum.quickSettings.shortcutRejected")}
                </span>
              )}
            </>
          }
        >
          <AcceleratorInput
            label={t("adversum.voice.settings.shortcut")}
            disabled={!platform.supportsGlobalShortcuts}
            value={settings.shortcutVoice}
            onChange={(accelerator) => void saveShortcut(accelerator)}
          />
        </SettingsRow>
        <SettingsRow
          label={t("adversum.voice.settings.tapMode")}
          description={t("adversum.voice.settings.tapModeDescription")}
        >
          <Toggle
            ariaLabel={t("adversum.voice.settings.tapMode")}
            checked={settings.voiceTapMode}
            onChange={(tapMode) => void update("voiceTapMode", tapMode)}
          />
        </SettingsRow>
      </SettingsList>
      <BrainSection />
      <SettingsNote>{t("adversum.voice.settings.privacy")}</SettingsNote>
    </SettingsPage>
  );
}
