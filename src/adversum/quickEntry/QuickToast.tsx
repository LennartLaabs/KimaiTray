import { useTranslation } from "react-i18next";
import type { QuickToastData } from "./quickEvents";

interface QuickToastProps {
  toast: QuickToastData;
  onUndo: () => void;
  /** Label of the undo key combination, e.g. "⌘Z". */
  undoKey: string;
}

/**
 * Confirmation after a quick action, shown as a small overlay at the bottom
 * of the screen. While the action can be undone it offers "Undo", by click
 * and with the key combination the native side holds for that time.
 */
export default function QuickToast({ toast, onUndo, undoKey }: QuickToastProps) {
  const { t } = useTranslation();
  const failed = toast.kind === "failed";
  return (
    <div
      role="status"
      data-quick-toast={toast.kind}
      className="flex items-center gap-3 px-4 py-3"
    >
      <span
        className={`line-clamp-2 min-w-0 flex-1 text-[14px] ${
          failed ? "text-red-600 dark:text-red-400" : "text-gray-900 dark:text-gray-100"
        }`}
      >
        {t(`adversum.quick.toast.${toast.kind}`, { label: toast.label })}
      </span>
      {toast.undoable && (
        <button
          type="button"
          onClick={onUndo}
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-2.5 py-1 text-[13px] font-semibold text-white hover:bg-[var(--accent-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          {t("adversum.quick.undo")}
          <kbd className="rounded bg-white/20 px-1 font-sans text-[11px] font-medium">
            {undoKey}
          </kbd>
        </button>
      )}
    </div>
  );
}
