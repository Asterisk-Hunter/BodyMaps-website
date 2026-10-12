import { useEffect, useState } from "react";
import { ORGAN_CLASS_COUNT, API_BASE } from "../../helpers/constants";
import { useAuth } from "../../contexts/authContext";
import { LANDING_OVERVIEW, LANDING_SUBTITLE } from "../../helpers/copy";
import styles from "./LandingPage.module.css";

const TARGETS = {
  // Fallback only (the live count is fetched from /api/search?dataset=all).
  ctVolumes: 34_323,
  medicalCenters: 145,
  annotatedStructures: 993_000,
  organClasses: ORGAN_CLASS_COUNT,
} as const;

const ANIMATION_DURATION = 2_200;

const formatStructures = (value: number): string => {
  if (value >= TARGETS.annotatedStructures) {
    return `${Math.floor(TARGETS.annotatedStructures / 1_000)}K+`;
  }

  if (value >= 1_000) {
    return `${Math.floor(value / 1_000)}K+`;
  }

  return String(value);
};

const easeOutCubic = (progress: number): number => {
  return 1 - Math.pow(1 - progress, 3);
};

export default function WorkspaceIntro({ collapsed = false }: { collapsed?: boolean }) {
  const { isAuthenticated } = useAuth();
  const [animationProgress, setAnimationProgress] = useState(0);
  // Pull the live CT-volume count so the hero stat reflects the real library size
  // (PanTS + CancerVerse) instead of a hardcoded figure. Falls back to TARGETS.
  const [ctVolumes, setCtVolumes] = useState<number | null>(null);

  useEffect(() => {
    // The public overview does not request protected dataset records.
    if (!isAuthenticated) return;
    let cancelled = false;
    fetch(`${API_BASE}/api/search?per_page=1&dataset=all`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d && typeof d.total === "number") setCtVolumes(d.total);
      })
      .catch(() => {
        /* keep the fallback target on any failure */
      });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  useEffect(() => {
    const motionPreference = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    );
    const startTime = performance.now();
    let animationFrameId: number | null = null;
    let finished = false;

    const finish = () => {
      finished = true;
      if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
      setAnimationProgress(1);
    };

    const animate = (currentTime: number) => {
      if (finished) return;
      const elapsed = currentTime - startTime;
      const progress = Math.max(0, Math.min(elapsed / ANIMATION_DURATION, 1));

      setAnimationProgress(easeOutCubic(progress));

      if (progress < 1) {
        animationFrameId = requestAnimationFrame(animate);
      } else {
        finished = true;
        animationFrameId = null;
      }
    };

    if (motionPreference.matches) finish();
    else animationFrameId = requestAnimationFrame(animate);
    // Stop immediately if reduced motion is enabled during the count-up.
    const onMotionPreference = () => { if (motionPreference.matches) finish(); };
    motionPreference.addEventListener?.("change", onMotionPreference);

    return () => {
      finished = true;
      if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
      motionPreference.removeEventListener?.("change", onMotionPreference);
    };
  }, []);

  const getAnimatedValue = (target: number) =>
    Math.round(animationProgress * target);

  const stats = [
    {
      value: getAnimatedValue(ctVolumes ?? TARGETS.ctVolumes).toLocaleString(
        "en-US",
      ),
      label: "CT Volumes",
    },
    {
      value: String(getAnimatedValue(TARGETS.medicalCenters)),
      label: "Medical Centers",
    },
    {
      value: formatStructures(getAnimatedValue(TARGETS.annotatedStructures)),
      label: "Annotated Structures",
    },
    {
      value: String(getAnimatedValue(TARGETS.organClasses)),
      label: "Organ Classes",
    },
  ];

  return (
    <div className={styles.root} data-collapsed={collapsed || undefined} aria-hidden={collapsed || undefined}>
      <div className={styles.content}>
      <section className={styles.hero} aria-label="Welcome to BodyMaps">
        <div className={styles.brandMark}><img src="/bodymaps-logo.svg" alt="" /></div>
        <p className={styles.welcome}>{isAuthenticated ? "Welcome back" : "Welcome to"}</p>
        <h1 className={styles.heroTitle}>
          Body<span className={styles.heroTitleAlt}>Maps</span>
        </h1>
        <p className={styles.heroSubtitle}>{LANDING_SUBTITLE}</p>
        <div className={styles.heroStats}>
          {stats.map((stat, index) => (
            <div key={stat.label} className={styles.statGroup}>
              <div className={styles.heroStatItem}>
                <div className={styles.heroStatValue}>{stat.value}</div>
                <div className={styles.heroStatLabel}>{stat.label}</div>
              </div>

              {index < stats.length - 1 && (
                <div className={styles.heroStatDivider} aria-hidden="true" />
              )}
            </div>
          ))}
        </div>
        <p className={styles.heroOverview}>{LANDING_OVERVIEW}</p>
      </section>
      </div>
    </div>
  );
}
