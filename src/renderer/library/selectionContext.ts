import { createContext, useContext, type MouseEvent } from "react";
import type { LocalClip } from "./types";

// Selection is applied imperatively (class toggles on the card DOM) to avoid
// re-rendering the whole grid on every click; this API is a stable context value.
export interface SelectionApi {
  isSelected(name: string): boolean;
  onCardClick(e: MouseEvent, clip: LocalClip): void;
  onCardContextMenu(e: MouseEvent, clip: LocalClip): void;
}

export const SelectionContext = createContext<SelectionApi | null>(null);

export function useSelection(): SelectionApi | null {
  return useContext(SelectionContext);
}
