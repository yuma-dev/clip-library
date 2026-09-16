import { createContext, useContext } from "react";

// renaming persists via IPC and updates the shared clip list + open player
// context avoids threading the callback through every intermediate component
export type RenameFn = (originalName: string, newName: string) => Promise<boolean>;

export const RenameContext = createContext<RenameFn | null>(null);

export function useRename(): RenameFn | null {
  return useContext(RenameContext);
}
