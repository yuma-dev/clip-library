import { Library, Rss, Settings, type LucideIcon } from "lucide-react";

// State-driven routing (plan D7) — no react-router in the core shell.
export type Route = "library" | "feed" | "settings";

export interface RouteDef {
  id: Route;
  label: string;
  icon: LucideIcon;
  /** Disabled entries are shown but not navigable yet (e.g. Feed — plan D3/Phase 8). */
  disabled?: boolean;
}

export const routes: RouteDef[] = [
  { id: "library", label: "Library", icon: Library },
  { id: "feed", label: "Feed", icon: Rss, disabled: true },
  { id: "settings", label: "Settings", icon: Settings },
];
