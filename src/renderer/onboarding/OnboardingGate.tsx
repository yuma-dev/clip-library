import { Suspense, lazy, useEffect, useState } from "react";
import { useSettings } from "../settings/SettingsContext";
import { ONBOARDING_VERSION } from "./version";

const OnboardingWizard = lazy(() => import("./OnboardingWizard"));

/**
 * Mounts the onboarding wizard (its own chunk, with framer-motion and the
 * clipdip settings tree) only when it is going to open: on a first run, or
 * when __showOnboarding() is called from the console before the wizard has
 * ever loaded. Once loaded, the wizard installs the real console hooks.
 */
export default function OnboardingGate() {
  const { settings, ready, set } = useSettings();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (mounted || !ready) return;
    if (Number(settings.onboardingVersion ?? 0) < ONBOARDING_VERSION) setMounted(true);
  }, [mounted, ready, settings.onboardingVersion]);

  useEffect(() => {
    if (mounted) return;
    const w = window as unknown as Record<string, unknown>;
    w.__showOnboarding = () => {
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
      <OnboardingWizard />
    </Suspense>
  );
}
