import { createContext, useContext } from "react";

// Renaming a clip persists via IPC and updates the shared clip list (and the
// open player). Exposed as a context so cards can trigger it without threading
// the callback through every intermediate component.
export type RenameFn = (originalName: string, newName: string) => Promise<boolean>;

export const RenameContext = createContext<RenameFn | null>(null);

export function useRename(): RenameFn | null {
  return useContext(RenameContext);
}
