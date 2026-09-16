import { Suspense, lazy, useEffect, useState } from "react";
import { useSettings } from "../settings/SettingsContext";
import { ONBOARDING_VERSION } from "./version";

const OnboardingWizard = lazy(() => import("./OnboardingWizard"));

/** mounts the wizard chunk only when it's about to open: first run, or __showOnboarding()
 * called from the console before the chunk has ever loaded */
export default function OnboardingGate() {
  const { settings, ready, set } = useSettings();
  const [mounted, setMounted] = useState(false);
  // set when __showOnboarding() fires before the chunk loaded, opens as soon as it mounts
  const [openOnMount, setOpenOnMount] = useState(false);

  useEffect(() => {
    if (mounted || !ready) return;
    if (Number(settings.onboardingVersion ?? 0) < ONBOARDING_VERSION) setMounted(true);
  }, [mounted, ready, settings.onboardingVersion]);

  useEffect(() => {
    if (mounted) return;
    const w = window as unknown as Record<string, unknown>;
    w.__showOnboarding = () => {
      setOpenOnMount(true);
      setMounted(true);
      return "onboarding: loading";
    };
    w.__resetOnboarding = () => {
      void set("onboardingVersion", 0);
      return "onboarding: flag cleared, wizard will show on next launch";
    };
  }, [mounted, set]);

  if (!mounted) return null;
  return (
    <Suspense fallback={null}>
      <OnboardingWizard openOnMount={openOnMount} />
    </Suspense>
  );
}
