import { createContext, useCallback, useContext, useEffect, useRef } from "react";

/** Registers an element with the shared visibility observer; returns cleanup. */
export type ObserveFn = (el: Element) => () => void;

export const ObserveContext = createContext<ObserveFn | null>(null);

export function useObserve(): ObserveFn | null {
  return useContext(ObserveContext);
}

/**
 * Shared offscreen-culling observer (hard-won §4.2): toggles `.cv-offscreen`
 * (content-visibility: hidden via styles.css) on registered cards as they
 * leave/enter the viewport, so far-offscreen cards stop costing layout/paint.
 * Provide the returned fn through ObserveContext; cards register on mount.
 * Root is the viewport — the app's scroll containers fill it, so this matches
 * the library grid's container-rooted observer behavior.
 */
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
