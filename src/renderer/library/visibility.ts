import { createContext, useCallback, useContext, useEffect, useRef } from "react";

/** Registers an element with the shared visibility observer; returns cleanup. */
export type ObserveFn = (el: Element) => () => void;

export const ObserveContext = createContext<ObserveFn | null>(null);

export function useObserve(): ObserveFn | null {
  return useContext(ObserveContext);
}

/** toggles `.cv-offscreen` (content-visibility: hidden, styles.css) on cards leaving/entering
 * the viewport so far-offscreen ones stop costing layout/paint (plan section 4.2) */
export function useVisibilityObserver(): ObserveFn {
  const observerRef = useRef<IntersectionObserver | null>(null);
  const observe = useCallback<ObserveFn>((el) => {
    if (!observerRef.current) {
      observerRef.current = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            (entry.target as HTMLElement).classList.toggle("cv-offscreen", !entry.isIntersecting);
          }
        },
        { rootMargin: "600px 0px" },
      );
    }
    observerRef.current.observe(el);
    return () => observerRef.current?.unobserve(el);
  }, []);
  useEffect(
    () => () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    },
    [],
  );
  return observe;
}
