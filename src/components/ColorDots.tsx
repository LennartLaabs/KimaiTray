import type { ColorMode } from "../types";
import { resolveDisplayColors } from "../utils/colorMode";
// ADVERSUM: customer logo indicator.
import { useCustomerIndicator } from "../adversum/display/CustomerIndicator";

interface ColorDotsProps {
  activityColor: string;
  projectColor: string;
  customerColor: string;
  colorMode: ColorMode;
  size?: "sm" | "md";
  pulse?: boolean;
  // ADVERSUM: project of the task and avatar size, for the customer logo.
  projectId?: number;
  variant?: "list" | "card";
}

export default function ColorDots({
  activityColor,
  projectColor,
  customerColor,
  colorMode,
  size = "md",
  pulse,
  projectId,
  variant,
}: ColorDotsProps) {
  const colors = resolveDisplayColors(
    activityColor,
    projectColor,
    customerColor,
    colorMode,
  );
  // ADVERSUM: in logo mode the customer avatar replaces the dots.
  const customerIndicator = useCustomerIndicator({
    projectId,
    variant,
    customerColor,
    dotColor: colors[0],
    pulse,
  });
  if (customerIndicator) return customerIndicator;
  const sizeClass = size === "sm" ? "h-1.5 w-1.5" : "h-2 w-2";
  const pulseClass = pulse ? "animate-pulse" : "";

  if (colors.length === 1) {
    return (
      <span
        className={`inline-block ${sizeClass} shrink-0 rounded-full ${pulseClass}`}
        style={{ backgroundColor: colors[0] }}
      />
    );
  }

  return (
    <span className="inline-flex gap-0.5 shrink-0">
      {colors.map((c, i) => (
        <span
          key={i}
          className={`inline-block ${sizeClass} rounded-full ${pulseClass}`}
          style={{ backgroundColor: c }}
        />
      ))}
    </span>
  );
}
