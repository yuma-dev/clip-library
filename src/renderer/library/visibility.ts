import { createContext, useContext } from "react";

/** Registers an element with the shared visibility observer; returns cleanup. */
export type ObserveFn = (el: Element) => () => void;

export const ObserveContext = createContext<ObserveFn | null>(null);

export function useObserve(): ObserveFn | null {
  return useContext(ObserveContext);
}
