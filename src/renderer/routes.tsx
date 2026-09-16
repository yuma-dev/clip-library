import { Library, Rss, Settings, type LucideIcon } from "lucide-react";

// state-driven routing, no react-router in the core shell
export type Route = "library" | "feed" | "settings";

export interface RouteDef {
  id: Route;
  label: string;
  icon: LucideIcon;
  /** disabled entries are shown but not navigable yet */
  disabled?: boolean;
}

export const routes: RouteDef[] = [
  { id: "library", label: "Library", icon: Library },
  { id: "feed", label: "Feed", icon: Rss },
  { id: "settings", label: "Settings", icon: Settings },
];
