import { createContext, useContext, type MouseEvent } from "react";
import type { LocalClip } from "./types";

// selection toggles classes on the card DOM directly, avoiding a re-render of the whole grid per click
export interface SelectionApi {
  isSelected(name: string): boolean;
  onCardClick(e: MouseEvent, clip: LocalClip): void;
  onCardContextMenu(e: MouseEvent, clip: LocalClip): void;
}

export const SelectionContext = createContext<SelectionApi | null>(null);

export function useSelection(): SelectionApi | null {
  return useContext(SelectionContext);
}
