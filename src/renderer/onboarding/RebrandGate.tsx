import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { useSettings } from "../settings/SettingsContext";
import { ONBOARDING_VERSION } from "./version";
import { afterIntro } from "../boot/bootHold";

const RebrandIntro = lazy(() => import("./RebrandIntro"));

/** the "ClipLib is now Setsu" card, once (settings.setsuIntroSeen). waits for the 3.0 tour, so
 * someone who gets both sees the tour first and this right after it. from devtools:
 *   __showRebrand()   - open now
 *   __resetRebrand()  - clear the seen flag */
export default function RebrandGate() {
  const { settings, ready, set } = useSettings();
  const [open, setOpen] = useState(false);
  // the chunk stays mounted after the first open so the card can animate out
  const [mounted, setMounted] = useState(false);
  const autoShown = useRef(false);

  const show = useCallback(() => {
    setMounted(true);
    setOpen(true);
  }, []);

  // opens once the boot reveal has settled; only unmount cancels the wait
  const cancelWait = useRef<() => void>(() => {});
  useEffect(() => () => cancelWait.current(), []);
  useEffect(() => {
    if (!ready || autoShown.current || settings.setsuIntroSeen) return;
    if (Number(settings.onboardingVersion ?? 0) < ONBOARDING_VERSION) return;
    autoShown.current = true;
    cancelWait.current = afterIntro(show);
  }, [ready, settings.setsuIntroSeen, settings.onboardingVersion, show]);

  // kept in production on purpose, like __showOnboarding
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__showRebrand = () => {
      show();
      return "rebrand intro: opened";
    };
    w.__resetRebrand = () => {
      void set("setsuIntroSeen", false);
      return "rebrand intro: flag cleared, shows on next launch";
    };
  }, [set, show]);

  const close = useCallback(() => {
    setOpen(false);
    void set("setsuIntroSeen", true);
  }, [set]);

  if (!mounted) return null;
  return (
    <Suspense fallback={null}>
      <RebrandIntro open={open} onClose={close} />
    </Suspense>
  );
}
