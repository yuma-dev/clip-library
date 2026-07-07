// App-level navigation context. Lets deep children (feed cards, mention
// avatars, profile links) open/close the profile overlay without prop drilling.
// Provided by App.tsx; consumed via `useAppNav()`.

import { createContext, useContext } from "react";

export interface AppNav {
  openProfile(userId: string): void;
  closeProfile(): void;
  /** Switch to the library route and clear any open profile overlay. */
  openLibrary(): void;
}

const noop = () => {};

export const AppNavContext = createContext<AppNav>({
  openProfile: noop,
  closeProfile: noop,
  openLibrary: noop,
});

export function useAppNav(): AppNav {
  return useContext(AppNavContext);
}
