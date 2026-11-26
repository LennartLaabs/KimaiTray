const WORD = /[\p{L}\p{N}]+/gu;
const FALLBACK_COLOR = "#6b7280";
const DARK_TEXT = "#111827";
const LIGHT_TEXT = "#ffffff";

/** One or two uppercase characters standing in for a customer without a logo. */
export function customerInitials(name: string): string {
  const [firstWord, secondWord] = name.match(WORD) ?? [];
  if (!firstWord) return "?";
  const [first = "", second = ""] = Array.from(firstWord);
  if (!secondWord) return (first + second).toUpperCase();
  const [next = ""] = Array.from(secondWord);
  return (first + next).toUpperCase();
}

/** A valid `#rrggbb` color, or neutral gray for anything else. */
export function avatarColor(color: string | null | undefined): string {
  return typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)
    ? color
    : FALLBACK_COLOR;
}

/** Black or white, whichever is readable on the given `#rrggbb` background. */
export function readableTextColor(background: string): string {
  const value = Number.parseInt(avatarColor(background).slice(1), 16);
  const channel = (shift: number) => {
    const srgb = ((value >> shift) & 0xff) / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  return luminance > 0.4 ? DARK_TEXT : LIGHT_TEXT;
}
