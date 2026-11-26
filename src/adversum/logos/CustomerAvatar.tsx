import { avatarColor, customerInitials, readableTextColor } from "./initials";

interface CustomerAvatarProps {
  /** Customer name; empty while the customer is not known yet. */
  name: string;
  /** Kimai customer color, used behind the initials. */
  color: string;
  /** `data:` URL of the logo, when one is cached. */
  logo?: string | null;
  /** Diameter in CSS pixels. */
  size: number;
  /** Activity color shown as a small dot at the avatar's lower right. */
  dotColor?: string;
  pulse?: boolean;
}

/** Round customer logo, or initials on the customer color when there is none. */
export default function CustomerAvatar({
  name,
  color,
  logo,
  size,
  dotColor,
  pulse,
}: CustomerAvatarProps) {
  const background = avatarColor(color);
  const dotSize = Math.max(6, Math.round(size * 0.32));
  return (
    <span
      data-customer-avatar
      title={name || undefined}
      className="relative inline-flex shrink-0"
      style={{ width: size, height: size }}
    >
      {logo ? (
        <img
          src={logo}
          alt=""
          draggable={false}
          className="h-full w-full rounded-full bg-white object-contain ring-1 ring-black/10 dark:ring-white/15"
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex h-full w-full select-none items-center justify-center rounded-full font-semibold leading-none"
          style={{
            backgroundColor: background,
            color: readableTextColor(background),
            fontSize: Math.round(size * 0.4),
          }}
        >
          {name ? customerInitials(name) : ""}
        </span>
      )}
      {dotColor && (
        <span
          data-activity-dot
          className={`absolute -bottom-px -right-px rounded-full ring-2 ring-white dark:ring-[#1a1a1a] ${
            pulse ? "animate-pulse" : ""
          }`}
          style={{ width: dotSize, height: dotSize, backgroundColor: dotColor }}
        />
      )}
    </span>
  );
}
