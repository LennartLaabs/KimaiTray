import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { buttonClass } from "../../settings/Controls";
import {
  cancelVoice,
  finishVoiceTest,
  startVoiceTest,
  VOICE_LEVEL_EVENT,
  type VoiceTestResult,
} from "../voice/voiceApi";

/** A test recording ends by itself after this long. */
export const TEST_SECONDS = 8;

const KNOWN_PROBLEMS = new Set([
  "busy",
  "permissionDenied",
  "permissionRequested",
  "noMicrophone",
]);

type Phase = "idle" | "recording" | "working";

function ignore(): void {
  // Nothing to do when the native side is gone.
}

function level(value: number): string {
  return value.toFixed(4);
}

/**
 * "Test microphone" on the voice settings page: records a few seconds from
 * the selected microphone with a live level, runs the same steps as a real
 * voice input and shows what came in and what was understood. The recording
 * is kept as WAV files, so a problem can be looked at afterwards.
 */
export default function MicrophoneTest() {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>("idle");
  const [meter, setMeter] = useState(0);
  const [result, setResult] = useState<VoiceTestResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  useEffect(() => {
    const listener = listen<number>(VOICE_LEVEL_EVENT, ({ payload }) => setMeter(payload));
    return () => {
      void listener.then((unlisten) => unlisten()).catch(ignore);
      // Leaving the page ends a test that is still recording.
      if (phaseRef.current === "recording") void cancelVoice().catch(ignore);
    };
  }, []);

  const stop = async () => {
    setPhase("working");
    try {
      setResult(await finishVoiceTest());
    } catch (error) {
      setProblem(String(error));
    }
    setPhase("idle");
    setMeter(0);
  };
  const stopRef = useRef(stop);
  stopRef.current = stop;

  useEffect(() => {
    if (phase !== "recording") return;
    const timer = setTimeout(() => void stopRef.current(), TEST_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [phase]);

  const start = async () => {
    setResult(null);
    setProblem(null);
    try {
      await startVoiceTest();
      setPhase("recording");
    } catch (error) {
      setProblem(String(error));
    }
  };

  const shown = Math.max(0, Math.min(1, meter));
  return (
    <div data-settings-item data-voice-test={phase} className="px-4 py-3">
      <div className="flex items-center justify-between gap-[18px]">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-[var(--s-fg)]">
            {t("adversum.voice.test.title")}
          </div>
          <div className="mt-0.5 max-w-[52ch] text-[11.5px] leading-[1.45] text-[var(--s-fg-subtle)]">
            {t("adversum.voice.test.description", { seconds: String(TEST_SECONDS) })}
          </div>
        </div>
        {phase === "recording" ? (
          <button type="button" className={buttonClass("primary")} onClick={() => void stop()}>
            {t("adversum.voice.test.stop")}
          </button>
        ) : (
          <button
            type="button"
            className={buttonClass()}
            disabled={phase === "working"}
            onClick={() => void start()}
          >
            {t(phase === "working" ? "adversum.voice.transcribing" : "adversum.voice.test.start")}
          </button>
        )}
      </div>

      {phase === "recording" && (
        <div
          role="meter"
          aria-label={t("adversum.voice.test.level")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(shown * 100)}
          className="mt-2.5 h-2 overflow-hidden rounded bg-[var(--s-line-soft)]"
        >
          <div
            className="h-full bg-emerald-500 transition-[width] duration-75"
            style={{ width: `${shown * 100}%` }}
          />
        </div>
      )}

      {problem && (
        <p role="alert" className="mt-2.5 text-[12px] text-red-500 dark:text-red-400">
          {KNOWN_PROBLEMS.has(problem) ? t(`adversum.voice.problem.${problem}`) : problem}
        </p>
      )}

      {result && (
        <div data-voice-test-result={result.outcome} className="mt-2.5 space-y-1 text-[12px]">
          <p
            className={
              result.outcome === "ok"
                ? "font-medium text-emerald-600 dark:text-emerald-400"
                : "font-medium text-amber-600 dark:text-amber-400"
            }
          >
            {result.outcome === "ok"
              ? t("adversum.voice.test.heard", { text: result.text })
              : t(`adversum.voice.problem.${result.outcome}`)}
          </p>
          {result.detail && <p className="font-mono text-[11px] text-red-500">{result.detail}</p>}
          <ul className="space-y-0.5 font-mono text-[11px] text-[var(--s-fg-subtle)]">
            <li>
              {t("adversum.voice.test.device", {
                device: result.info.device,
                rate: String(result.info.sampleRate),
                channels: String(result.info.channels),
                format: result.info.sampleFormat,
                seconds: result.report.seconds.toFixed(1),
              })}
            </li>
            <li>
              {t("adversum.voice.test.levels", {
                levels: result.report.channelRms
                  .map((rms, index) => `${level(rms)} / ${level(result.report.channelPeak[index] ?? 0)}`)
                  .join(" · "),
                channel: String(result.report.usedChannel + 1),
              })}
            </li>
            <li>
              {t("adversum.voice.test.speech", {
                floor: level(result.report.noiseFloor),
                level: level(result.report.speechLevel),
                gain: result.report.gain.toFixed(1),
              })}
            </li>
            {result.rawPath && (
              <li className="break-all">
                {t("adversum.voice.test.saved", { path: result.rawPath })}
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
