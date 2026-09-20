// lets deep children (feed cards, mentions, profile links) open/close the profile overlay without
// prop drilling
// provided by App.tsx, consumed via useAppNav()

import { createContext, useContext } from "react";

export interface AppNav {
  openProfile(userId: string): void;
  closeProfile(): void;
  /** Switch to the library route and clear any open profile overlay. */
  openLibrary(): void;
  /** Switch to settings, landing on a section (nav id, e.g. "audio") when given. */
  openSettings(section?: string): void;
}

const noop = () => {};

export const AppNavContext = createContext<AppNav>({
  openProfile: noop,
  closeProfile: noop,
  openLibrary: noop,
  openSettings: noop,
});

export function useAppNav(): AppNav {
  return useContext(AppNavContext);
}
