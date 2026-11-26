import type { ReactNode } from "react";
import { useAdversumDisplay } from "./displayStore";

interface TimerCardTitleProps {
  /** Kimai project of the timer; its customer is looked up from it. */
  projectId?: number;
  project: string;
  activity: string;
  /** Take the free width of the row (where the replaced markup did). */
  grow?: boolean;
  /** Upstream's own title markup, kept as it is when the fork display is off. */
  children: ReactNode;
}

/**
 * Title of a timer card with the customer first: line 1 the customer in
 * bold, line 2 "project · activity", the same order as in the lists. Several
 * customers have a project with the same name, so the project alone does not
 * say whose timer is running.
 *
 * Renders upstream's markup unchanged outside the running app and while the
 * customer of the project is not known.
 */
export default function TimerCardTitle({
  projectId,
  project,
  activity,
  grow,
  children,
}: TimerCardTitleProps) {
  const display = useAdversumDisplay();
  const customer = projectId == null ? undefined : display?.customersByProject.get(projectId);
  if (!customer) return <>{children}</>;
  return (
    <span
      data-card-title
      className={`flex min-w-0 flex-col leading-tight ${grow ? "flex-1" : ""}`}
    >
      <span className="truncate text-xs font-semibold text-gray-800 dark:text-gray-200">
        {customer.name}
      </span>
      <span className="truncate text-[10px] text-gray-500 dark:text-gray-400">
        {project} · {activity}
      </span>
    </span>
  );
}
