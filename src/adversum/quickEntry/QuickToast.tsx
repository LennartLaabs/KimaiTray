import { useTranslation } from "react-i18next";
import type { QuickToastData } from "./quickEvents";

interface QuickToastProps {
  toast: QuickToastData;
  onUndo: () => void;
  /** "popup": overlay at the bottom of the tray popup. "window": fills the bar. */
  variant: "window" | "popup";
}

/** Confirmation after a quick action, with "Undo" while it can be undone. */
export default function QuickToast({ toast, onUndo, variant }: QuickToastProps) {
  const { t } = useTranslation();
  const failed = toast.kind === "failed";
  return (
    <div
      role="status"
      data-quick-toast={toast.kind}
      className={
        variant === "window"
          ? "flex items-center gap-3 px-4 py-3.5"
          : "pointer-events-auto absolute inset-x-3 bottom-12 z-40 flex items-center gap-2 rounded-lg bg-gray-900 px-3 py-2 shadow-xl dark:bg-gray-100"
      }
    >
      <span
        className={`min-w-0 flex-1 ${
          variant === "window"
            ? `truncate text-[15px] ${failed ? "text-red-600 dark:text-red-400" : "text-gray-900 dark:text-gray-100"}`
            : `line-clamp-2 text-xs ${failed ? "text-red-300 dark:text-red-600" : "text-white dark:text-gray-900"}`
        }`}
      >
        {t(`adversum.quick.toast.${toast.kind}`, { label: toast.label })}
      </span>
      {toast.undoable && (
        <button
          type="button"
          onClick={onUndo}
          className={`shrink-0 rounded font-semibold underline-offset-2 hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] ${
            variant === "window"
              ? "text-[13px] text-[var(--accent)]"
              : "text-xs text-emerald-300 dark:text-emerald-700"
          }`}
        >
          {t("adversum.quick.undo")}
        </button>
      )}
    </div>
  );
}
