import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { Segmented, buttonClass } from "../../settings/Controls";
import {
  RadioDot,
  SettingsList,
  SettingsRow,
  SettingsWarning,
} from "../../settings/SettingsLayout";
import {
  deleteBrainModel,
  downloadBrainModel,
  getBrainStatus,
  getMultiModelStatus,
  type BrainStatus,
} from "../multi/modelApi";
import {
  cancelVoiceDownload,
  chooseVoiceModelDir,
  VOICE_DOWNLOAD_EVENT,
  type VoiceDownload,
} from "../voice/voiceApi";
import { MULTI_MODEL_MODES, type BrainModel, type MultiModelMode } from "./adversumSettings";
import { useAdversumSettings } from "./useAdversumSettings";
import { formatSize } from "./formatSize";

function ignore() {
  // Outcomes arrive as events or through the next status read.
}

/**
 * "AI model for complex sentences" on the voice settings page: the local
 * language model that reads what the rules cannot. Its files are handled
 * like the speech models (download with progress, size, folder, delete);
 * below them, whether Claude Code may be asked as well.
 */
export default function BrainSection() {
  const { t } = useTranslation();
  const { settings, update } = useAdversumSettings();
  const [status, setStatus] = useState<BrainStatus | null>(null);
  const [claude, setClaude] = useState(false);
  const [download, setDownload] = useState<VoiceDownload | null>(null);
  const [problem, setProblem] = useState<"download" | "folder" | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await getBrainStatus();
      setStatus(next);
      setDownload(next.download);
    } catch {
      setStatus(null);
    }
    setClaude(await getMultiModelStatus().then((models) => models.claude, () => false));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, settings.brainModelDir]);

  useEffect(() => {
    const listener = listen<VoiceDownload>(VOICE_DOWNLOAD_EVENT, ({ payload }) => {
      if (payload.state === "progress") {
        setDownload(payload);
        return;
      }
      if (payload.state === "failed") setProblem("download");
      void refresh();
    });
    return () => {
      void listener.then((unlisten) => unlisten()).catch(ignore);
    };
  }, [refresh]);

  if (!status) return null;

  const startDownload = (model: BrainModel) => {
    setProblem(null);
    setDownload({ model, state: "progress", received: 0, total: 0 });
    void downloadBrainModel(model).catch(ignore);
  };
  const remove = async (model: BrainModel) => {
    await deleteBrainModel(model).catch(ignore);
    await refresh();
  };
  const chooseFolder = async () => {
    setProblem(null);
    const folder = await chooseVoiceModelDir().catch(() => null);
    if (folder && !(await update("brainModelDir", folder))) setProblem("folder");
  };

  return (
    <>
      {status.modelVolume && (
        <SettingsWarning>
          <span data-brain-volume>
            {t("adversum.brain.modelVolume", { volume: status.modelVolume })}
          </span>{" "}
          <button
            type="button"
            className={buttonClass("secondary", "sm")}
            onClick={() => void update("brainModelDir", "")}
          >
            {t("adversum.brain.useInternal")}
          </button>
        </SettingsWarning>
      )}
      {!status.helper && (
        <SettingsWarning>
          <span data-brain-no-helper>{t("adversum.brain.noHelper")}</span>
        </SettingsWarning>
      )}
      <SettingsList title={t("adversum.brain.title")} description={t("adversum.brain.description")}>
        {status.models.map((model) => {
          const name = t(`adversum.brain.models.${model.id}.name`);
          const loading = download?.model === model.id ? download : null;
          const percent =
            loading && loading.total > 0
              ? Math.floor((loading.received / loading.total) * 100)
              : 0;
          return (
            <div
              key={model.id}
              data-settings-item
              data-brain-model={model.id}
              className="border-b border-[var(--s-line-soft)] px-4 py-3 last:border-b-0"
            >
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  role="radio"
                  aria-checked={settings.brainModel === model.id}
                  onClick={() => void update("brainModel", model.id)}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                >
                  <RadioDot active={settings.brainModel === model.id} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-[var(--s-fg)]">
                      {name} · {formatSize(model.sizeBytes)}
                    </span>
                    <span className="block text-[11.5px] text-[var(--s-fg-subtle)]">
                      {t(`adversum.brain.models.${model.id}.note`)}
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
                  <div className="h-full bg-[var(--accent)]" style={{ width: `${percent}%` }} />
                </div>
              )}
            </div>
          );
        })}
        {problem === "download" && (
          <p role="alert" className="px-4 py-2 text-[12px] text-red-500 dark:text-red-400">
            {t("adversum.voice.settings.downloadFailed")}
          </p>
        )}
        <SettingsRow
          label={t("adversum.voice.settings.folder")}
          description={
            <>
              <span data-brain-dir className="block break-all font-mono text-[11px]">
                {status.modelDir}
              </span>
              {problem === "folder" && (
                <span role="alert" className="mt-1 block text-red-500 dark:text-red-400">
                  {t("adversum.voice.settings.folderRejected")}
                </span>
              )}
            </>
          }
        >
          {settings.brainModelDir !== "" && (
            <button
              type="button"
              className={buttonClass("ghost", "sm")}
              onClick={() => void update("brainModelDir", "")}
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
        <SettingsRow
          label={t("adversum.brain.mode")}
          description={
            <>
              {t("adversum.brain.modeDescription")}
              <span data-brain-claude className="mt-1 block">
                {t(`adversum.brain.claude.${claude ? "found" : "missing"}`)}
              </span>
            </>
          }
        >
          <Segmented<MultiModelMode>
            ariaLabel={t("adversum.brain.mode")}
            value={settings.multiModel}
            onChange={(mode) => void update("multiModel", mode)}
            options={MULTI_MODEL_MODES.map((value) => ({
              value,
              label: t(`adversum.brain.modeOption.${value}`),
            }))}
          />
        </SettingsRow>
      </SettingsList>
    </>
  );
}
