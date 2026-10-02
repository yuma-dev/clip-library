import type { LucideIcon } from "lucide-react";

/** Discord's mark in lucide's shape, so it sits in the settings rail with the other icons */
function DiscordIcon({ size = 16 }: { size?: number | string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M19.54 5.34A17.6 17.6 0 0 0 15.2 4l-.2.4a12.7 12.7 0 0 1 3.83 1.9 14.7 14.7 0 0 0-13.66 0A12.7 12.7 0 0 1 9 4.4L8.8 4a17.6 17.6 0 0 0-4.34 1.34C1.7 9.45.96 13.46 1.33 17.4a17.8 17.8 0 0 0 5.33 2.67l1.15-1.83a11.4 11.4 0 0 1-1.8-.86l.44-.33a12.6 12.6 0 0 0 11.1 0l.44.33c-.57.34-1.18.63-1.8.86l1.15 1.83a17.8 17.8 0 0 0 5.33-2.67c.43-4.57-.74-8.54-3.13-12.06ZM8.68 15.04c-1.04 0-1.9-.95-1.9-2.13s.84-2.14 1.9-2.14 1.92.96 1.9 2.14c0 1.18-.84 2.13-1.9 2.13Zm6.64 0c-1.04 0-1.9-.95-1.9-2.13s.84-2.14 1.9-2.14 1.92.96 1.9 2.14c0 1.18-.83 2.13-1.9 2.13Z" />
    </svg>
  );
}

export default DiscordIcon as unknown as LucideIcon;
