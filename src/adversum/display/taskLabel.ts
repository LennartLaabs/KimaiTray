import { useAdversumDisplay } from "./displayStore";

interface LabelSource {
  project: string;
  activity: string;
  customer: string;
  description: string;
}

export interface TaskLabel {
  /** Emphasized first line. */
  title: string;
  /** Small text next to the title; empty in the customer-first layout. */
  aside: string;
  /** Second line. */
  subtitle: string;
  /** Tailwind font weight for the title. */
  titleWeight: string;
}

/** Upstream layout: project and activity on top, customer and note below. */
export function upstreamTaskLabel(task: LabelSource): TaskLabel {
  return {
    title: task.project,
    aside: task.activity,
    subtitle: [task.customer, task.description].filter(Boolean).join(" · "),
    titleWeight: "font-medium",
  };
}

/**
 * Customer-first layout: the customer name on top, then
 * "project · activity · note". Projects such as "Marketing Retainer" exist for
 * several customers, so the customer is what tells list entries apart.
 */
export function customerFirstTaskLabel(task: LabelSource): TaskLabel {
  if (!task.customer) {
    return {
      title: task.project,
      aside: "",
      subtitle: [task.activity, task.description].filter(Boolean).join(" · "),
      titleWeight: "font-semibold",
    };
  }
  return {
    title: task.customer,
    aside: "",
    subtitle: [task.project, task.activity, task.description]
      .filter(Boolean)
      .join(" · "),
    titleWeight: "font-semibold",
  };
}

/** Labels for a list entry; customer-first whenever the fork display is active. */
export function useTaskLabel(task: LabelSource): TaskLabel {
  return useAdversumDisplay() ? customerFirstTaskLabel(task) : upstreamTaskLabel(task);
}
