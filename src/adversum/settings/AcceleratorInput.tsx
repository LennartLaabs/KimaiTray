import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { currentPlatform } from "../../platform";

/**
 * Records a global shortcut. Unlike upstream's `ShortcutInput` it keeps
 * Control and Command apart, because the fork's defaults use ⌃⌥ on macOS.
 */

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);
const MAC_SYMBOLS: Record<string, string> = {
  Control: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  Command: "⌘",
};

interface KeyPress {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** The accelerator for a key press, or `null` when it is not a full shortcut. */
export function acceleratorFromKey(event: KeyPress): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Control");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Command");
  if (parts.length === 0) return null;
  const key = event.code.startsWith("Key")
    ? event.code.slice(3)
    : event.code.startsWith("Digit")
      ? event.code.slice(5)
      : event.code;
  if (!key) return null;
  return [...parts, key].join("+");
}

/** "Control+Alt+Space" → "⌃⌥Space" on macOS, "Ctrl+Alt+Space" elsewhere. */
export function formatAccelerator(accelerator: string, mac: boolean): string {
  const parts = accelerator.split("+").filter(Boolean);
  if (mac) return parts.map((part) => MAC_SYMBOLS[part] ?? part).join("");
  return parts
    .map((part) => (part === "Control" ? "Ctrl" : part === "Command" ? "Super" : part))
    .join("+");
}

interface AcceleratorInputProps {
  value: string;
  onChange: (accelerator: string) => void;
  label: string;
  disabled?: boolean;
}

export default function AcceleratorInput({
  value,
  onChange,
  label,
  disabled,
}: AcceleratorInputProps) {
  const { t } = useTranslation();
  const [recording, setRecording] = useState(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const mac = currentPlatform().os === "macos";

  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecording(false);
        return;
      }
      const accelerator = acceleratorFromKey(event);
      if (!accelerator) return;
      setRecording(false);
      onChangeRef.current(accelerator);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recording]);

  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        type="button"
        disabled={disabled}
        aria-label={`${label}: ${t("adversum.quickSettings.record")}`}
        onClick={() => setRecording((current) => !current)}
        onBlur={() => setRecording(false)}
        className={`inline-flex h-[31px] min-w-[120px] items-center justify-center rounded-lg border px-3 font-mono text-[12px]
          focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50 ${
            recording
              ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
              : "border-[var(--s-line)] bg-[var(--s-card)] text-[var(--s-fg)] hover:bg-[var(--s-hover)]"
          }`}
      >
        {recording
          ? t("adversum.quickSettings.recording")
          : value
            ? formatAccelerator(value, mac)
            : t("adversum.quickSettings.none")}
      </button>
      {value && !recording && (
        <button
          type="button"
          disabled={disabled}
          aria-label={`${label}: ${t("adversum.quickSettings.clear")}`}
          title={t("adversum.quickSettings.clear")}
          onClick={() => onChange("")}
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--s-fg-subtle)] hover:bg-[var(--s-hover)] hover:text-[var(--s-fg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50"
        >
          <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      )}
    </span>
  );
}
