import { createContext, useContext } from "react";
import type { LibraryHover } from "./hoverController";

export const HoverContext = createContext<LibraryHover | null>(null);

export function useHover(): LibraryHover | null {
  return useContext(HoverContext);
}
