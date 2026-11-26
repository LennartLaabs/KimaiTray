import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { KimaiClient } from "../../api/kimaiClient";
import type { KimaiTimesheetEntry } from "../../api/kimaiTypes";
import type { PausedTimerData } from "../../api/pauseStore";
import { deleteTimesheet, getActiveTimesheets, updateTimesheet } from "../../api/timesheetApi";
import { invalidateTimesheets } from "../../hooks/invalidateTimesheets";
import { acquireTimerOperation } from "../../hooks/timerOperationLock";
import type { StartPreview } from "../../hooks/useStartTask";
import type { StartTaskPayload } from "../../services/timerService";
import type { ActiveTimer, RecentTask } from "../../types";
import { logger } from "../../utils/logger";
import { parseKimaiDate, toKimaiLocal } from "../../utils/time";
import type { QuickAction } from "./actions";
import type { QuickCommand } from "./commands";
import {
  loadInterruptLink,
  saveInterruptLink,
  type InterruptLink,
} from "./interruptLink";
import { createFinishedEntry, createRunningEntry, reopenTimesheet } from "./quickApi";
import {
  PREVIOUS_TASK_EVENT,
  QUICK_EXECUTE_EVENT,
  QUICK_TOAST_EVENT,
  QUICK_UNDO_EVENT,
  QUICK_UNDO_LATEST_EVENT,
  QUICK_WINDOW_LABEL,
  TOAST_DURATION_MS,
  type QuickExecuteRequest,
  type QuickToastData,
  type QuickToastKind,
  type QuickUndoRequest,
} from "./quickEvents";

const PAUSE_WAIT_MS = 15_000;
const PAUSE_POLL_MS = 50;

/** The timer operations of the tray popup that quick actions are built from. */
export interface QuickExecutorOptions {
  client: KimaiClient | null;
  connectionId: string;
  /** The list of running timers reflects the server (not still loading). */
  timersReady: boolean;
  /** Running timers, the main one first. */
  timers: readonly ActiveTimer[];
  pausedTimers: readonly PausedTimerData[];
  /** Recent tasks, newest first, without the running ones. */
  recentTasks: readonly RecentTask[];
  /** Another timer operation is in flight. */
  busy: boolean;
  startTask: (
    payload: StartTaskPayload,
    trackingKey?: string,
    preview?: StartPreview,
  ) => Promise<KimaiTimesheetEntry | null>;
  pauseTimer: (target?: ActiveTimer) => void;
  resumeTimer: (id: string) => void;
  discardPausedTimer: (id: string) => void;
  stopActiveTimer: (target?: ActiveTimer) => void;
}

/** A running timer as it was before a batch of entries took its place. */
interface RemovedTimer {
  projectId: number;
  activityId: number;
  description: string;
  begin: string;
}

/** What "Undo" has to do for one confirmation. */
interface UndoPlan {
  /** The entries the action created. */
  deleteIds: readonly number[];
  /** Entries the action stopped; they run again afterwards. */
  reopenIds: readonly number[];
  /** A running entry the action removed; it is created again. */
  restore?: RemovedTimer | null;
  /** Paused timer of an "in between" start; obsolete once its entry runs again. */
  discardPausedId: string | null;
}

interface QuickExecutor {
  execute: (action: QuickAction, learned?: string) => Promise<void>;
  undo: (toastId: number) => Promise<void>;
  /** The current confirmation, cleared after a few seconds. */
  toast: QuickToastData | null;
}

function timerLabel(timer: { project: string; activity: string }): string {
  return `${timer.project} · ${timer.activity}`;
}

/** Polls `probe` until it returns a value; `null` when it never does. */
function waitFor<T>(probe: () => T | null): Promise<T | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + PAUSE_WAIT_MS;
    const check = () => {
      const value = probe();
      if (value !== null) resolve(value);
      else if (Date.now() >= deadline) resolve(null);
      else setTimeout(check, PAUSE_POLL_MS);
    };
    check();
  });
}

/**
 * Runs quick actions with the tray popup's own timer operations, so they share
 * its locks, retry queue and cache updates. Lives in the tray window, which
 * exists for the whole app lifetime; other windows send their actions here.
 */
export function useQuickExecutor(options: QuickExecutorOptions): QuickExecutor {
  const qc = useQueryClient();
  const latest = useRef(options);
  latest.current = options;
  const [toast, setToast] = useState<QuickToastData | null>(null);
  const toastId = useRef(0);
  const pendingUndo = useRef<{ id: number; plan: UndoPlan } | null>(null);
  const [link, setLink] = useState<InterruptLink | null>(null);
  /** Id of the linked "in between" entry once it was seen running. */
  const linkSeenRunning = useRef<number | null>(null);
  /** Whether the link was made in this session or read from storage. */
  const linkOrigin = useRef<"created" | "loaded">("loaded");
  const { connectionId, timersReady, timers, pausedTimers, busy, resumeTimer } = options;

  const announce = useCallback(
    (kind: QuickToastKind, label = "", plan?: UndoPlan, detail?: string) => {
      const data: QuickToastData = {
        id: ++toastId.current,
        kind,
        label,
        undoable: !!plan,
        ...(detail ? { detail } : {}),
      };
      pendingUndo.current = plan ? { id: data.id, plan } : null;
      setToast(data);
      void emitTo(QUICK_WINDOW_LABEL, QUICK_TOAST_EVENT, data).catch(() => undefined);
    },
    [],
  );

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => {
      if (pendingUndo.current?.id === toast.id) pendingUndo.current = null;
      setToast(null);
    }, TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const storeLink = useCallback((next: InterruptLink | null) => {
    saveInterruptLink(latest.current.connectionId, next);
    linkSeenRunning.current = null;
    linkOrigin.current = "created";
    setLink(next);
  }, []);

  useEffect(() => {
    linkSeenRunning.current = null;
    linkOrigin.current = "loaded";
    setLink(connectionId ? loadInterruptLink(connectionId) : null);
  }, [connectionId]);

  // Resume the interrupted timer once its "in between" task has stopped.
  useEffect(() => {
    if (!link || !timersReady || busy) return;
    if (timers.some((timer) => timer.id === link.timesheetId)) {
      linkSeenRunning.current = link.timesheetId;
      return;
    }
    const seenRunning = linkSeenRunning.current === link.timesheetId;
    // A task started a moment ago may not be in the list of running timers
    // yet. A link read from storage whose task is not running is left over
    // from an earlier session.
    if (!seenRunning && linkOrigin.current === "created") return;
    const waiting = pausedTimers.find((paused) => paused.id === link.pausedId);
    const taskWasPaused = pausedTimers.some(
      (paused) => paused.lastTimesheetId === link.timesheetId,
    );
    storeLink(null);
    // Only a plain stop resumes: not a switch to another task, not pausing
    // the task itself, and not a link left over from an earlier session.
    if (seenRunning && waiting && timers.length === 0 && !taskWasPaused) {
      resumeTimer(waiting.id);
    }
  }, [link, timersReady, busy, timers, pausedTimers, resumeTimer, storeLink]);

  const runCommand = useCallback(
    async (command: QuickCommand) => {
      const current = latest.current;
      const [running] = current.timers;
      if (command === "stop" || command === "pause") {
        if (!running) return announce("nothing");
        if (command === "stop") current.stopActiveTimer(running);
        else current.pauseTimer(running);
        return announce(command === "stop" ? "stopped" : "paused", timerLabel(running));
      }
      if (command === "resume") {
        const paused = [...current.pausedTimers].sort((a, b) =>
          b.pausedAt.localeCompare(a.pausedAt),
        )[0];
        if (!paused) return announce("nothing");
        current.resumeTimer(paused.id);
        return announce("resumed", timerLabel(paused));
      }
      // "previous": the newest task that is not running. Used again, it leads
      // back, because by then the roles have swapped.
      const [previous] = current.recentTasks;
      if (!previous) return announce("nothing");
      const stopped = current.timers.map((timer) => timer.id);
      const label = `${previous.customer || previous.project} · ${previous.activity}`;
      const entry = await current.startTask(
        {
          projectId: previous.projectId,
          activityId: previous.activityId,
          description: previous.description || undefined,
          tags: previous.tags.length > 0 ? previous.tags : undefined,
          label,
        },
        previous.key,
        previous,
      );
      if (!entry) return announce("failed", label);
      announce("started", label, {
        deleteIds: [entry.id],
        reopenIds: stopped,
        discardPausedId: null,
      });
    },
    [announce],
  );

  /**
   * Enters several finished entries at once. The running timer they describe
   * is ended where they begin, or removed when they cover all of it. If any
   * step fails, everything done so far is taken back.
   */
  const runBatch = useCallback(
    async (action: Extract<QuickAction, { type: "batch" }>) => {
      const current = latest.current;
      const client = current.client!;
      const release = acquireTimerOperation(qc, client.cacheScope);
      if (!release) return announce("failed", action.label);
      const created: number[] = [];
      const running = action.timer
        ? current.timers.find((timer) => timer.id === action.timer!.id)
        : undefined;
      let ended: number | null = null;
      let removed: RemovedTimer | null = null;
      try {
        if (running && action.timer!.end) {
          await updateTimesheet(client, running.id, { end: action.timer!.end });
          ended = running.id;
        } else if (running) {
          await deleteTimesheet(client, running.id);
          removed = {
            projectId: running.projectId,
            activityId: running.activityId,
            description: running.description,
            begin: toKimaiLocal(parseKimaiDate(running.beginIso)),
          };
        }
        for (const entry of action.entries) {
          created.push((await createFinishedEntry(client, entry)).id);
        }
      } catch (error) {
        logger.error(`Entering several entries failed: ${String(error)}`);
        for (const id of created) await deleteTimesheet(client, id).catch(() => undefined);
        if (ended !== null) await reopenTimesheet(client, ended).catch(() => undefined);
        if (removed) await createRunningEntry(client, removed).catch(() => undefined);
        release();
        await invalidateTimesheets(qc);
        return announce("failed", action.label);
      }
      release();
      await invalidateTimesheets(qc);
      announce("logged", action.label, {
        deleteIds: created,
        reopenIds: ended === null ? [] : [ended],
        restore: removed,
        discardPausedId: null,
      });
    },
    [announce, qc],
  );

  const execute = useCallback(
    async (action: QuickAction, learned?: string) => {
      const current = latest.current;
      const label =
        action.type === "start" || action.type === "log" || action.type === "batch"
          ? action.label
          : "";
      if (!current.client) return announce("failed", label);
      try {
        if (action.type === "command") return await runCommand(action.command);
        if (action.type === "note") {
          const [running] = current.timers;
          if (!running) return announce("nothing");
          await updateTimesheet(current.client, running.id, {
            description: [running.description, action.text].filter(Boolean).join("\n"),
          });
          await invalidateTimesheets(qc);
          return announce("noted", timerLabel(running));
        }
        if (action.type === "log") {
          const created = await createFinishedEntry(current.client, action);
          await invalidateTimesheets(qc);
          return announce(
            "logged",
            label,
            { deleteIds: [created.id], reopenIds: [], discardPausedId: null },
            learned,
          );
        }
        if (action.type === "batch") return await runBatch(action);

        const stopped = current.timers.map((timer) => timer.id);
        const [running] = current.timers;
        let interrupted: { timesheetId: number; pausedId: string } | null = null;
        if (action.mode === "interrupt" && running) {
          if (current.busy) return announce("failed", label);
          current.pauseTimer(running);
          const paused = await waitFor(() => {
            const now = latest.current;
            if (now.busy || now.timers.some((timer) => timer.id === running.id)) return null;
            return now.pausedTimers.find((item) => item.lastTimesheetId === running.id) ?? null;
          });
          if (!paused) return announce("failed", label);
          interrupted = { timesheetId: running.id, pausedId: paused.id };
        }

        const entry = await latest.current.startTask(
          {
            projectId: action.projectId,
            activityId: action.activityId,
            description: action.description || undefined,
            begin: action.begin ?? undefined,
            label,
          },
          undefined,
          action.preview,
        );
        if (!entry) return announce("failed", label);
        if (interrupted) storeLink({ timesheetId: entry.id, pausedId: interrupted.pausedId });
        announce(
          "started",
          label,
          {
            deleteIds: [entry.id],
            reopenIds: interrupted ? [interrupted.timesheetId] : stopped,
            discardPausedId: interrupted?.pausedId ?? null,
          },
          learned,
        );
      } catch (error) {
        logger.error(`Quick action failed: ${String(error)}`);
        announce("failed", label);
      }
    },
    [announce, qc, runBatch, runCommand, storeLink],
  );

  const undo = useCallback(
    async (id: number) => {
      const pending = pendingUndo.current;
      const { client } = latest.current;
      if (!pending || pending.id !== id || !client) return;
      pendingUndo.current = null;
      const { plan } = pending;
      const release = acquireTimerOperation(qc, client.cacheScope);
      if (!release) return announce("failed");
      let undone = false;
      try {
        for (const createdId of plan.deleteIds) await deleteTimesheet(client, createdId);
        if (plan.restore) await createRunningEntry(client, plan.restore);
        if (plan.reopenIds.length > 0) {
          const active = new Set((await getActiveTimesheets(client)).map((entry) => entry.id));
          for (const stoppedId of plan.reopenIds) {
            if (!active.has(stoppedId)) await reopenTimesheet(client, stoppedId);
          }
        }
        undone = true;
      } catch (error) {
        logger.error(`Undo failed: ${String(error)}`);
      } finally {
        release();
        await invalidateTimesheets(qc);
      }
      if (undone && plan.discardPausedId) {
        // The interrupted entry runs again, so its paused stand-in is obsolete.
        storeLink(null);
        latest.current.discardPausedTimer(plan.discardPausedId);
      }
      announce(undone ? "undone" : "failed");
    },
    [announce, qc, storeLink],
  );

  useEffect(() => {
    const currentWindow = getCurrentWindow();
    const listeners = [
      currentWindow.listen<QuickExecuteRequest>(QUICK_EXECUTE_EVENT, ({ payload }) => {
        void execute(payload.action, payload.learned);
      }),
      currentWindow.listen<QuickUndoRequest>(QUICK_UNDO_EVENT, ({ payload }) => {
        void undo(payload.id);
      }),
      currentWindow.listen(QUICK_UNDO_LATEST_EVENT, () => {
        const pending = pendingUndo.current;
        if (pending) void undo(pending.id);
      }),
      currentWindow.listen(PREVIOUS_TASK_EVENT, () => {
        void execute({ type: "command", command: "previous" });
      }),
    ];
    return () => {
      for (const listener of listeners) {
        void listener.then((unlisten) => unlisten()).catch(() => undefined);
      }
    };
  }, [execute, undo]);

  return { execute, undo, toast };
}
