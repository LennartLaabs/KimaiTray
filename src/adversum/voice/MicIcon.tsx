export default function MicIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.8}
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path strokeLinecap="round" d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21" />
    </svg>
  );
}
