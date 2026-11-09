function isSpinner(effect: KeyframeEffect, name: string): boolean {
  if (name === "spin") return true;
  const target = effect.target;
  if (!(target instanceof Element)) return false;
  if (!target.matches(".animate-spin, .wp-status-mark[data-state=working]"))
    return false;

  let fullTurn = false;
  const frames = effect.getKeyframes();
  for (const frame of frames) {
    for (const [property, value] of Object.entries(frame)) {
      if (
        ["offset", "computedOffset", "easing", "composite"].includes(property)
      )
        continue;
      if (property === "transform" && typeof value === "string") {
        if (!/^(none|rotate\((0|360)deg\)|rotate\((0|1)turn\))$/.test(value))
          return false;
        fullTurn ||= value === "rotate(360deg)" || value === "rotate(1turn)";
      } else if (property === "rotate" && typeof value === "string") {
        if (!/^(none|(0|360)deg|(0|1)turn)$/.test(value)) return false;
        fullTurn ||= value === "360deg" || value === "1turn";
      } else {
        return false;
      }
    }
  }
  return fullTurn;
}

export function installSynchronizedSpinners(): () => void {
  if (
    typeof CSSAnimation === "undefined" ||
    typeof KeyframeEffect === "undefined" ||
    typeof document.getAnimations !== "function"
  )
    return () => {};

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  function synchronize(animation: Animation): void {
    if (
      reducedMotion.matches ||
      !(animation instanceof CSSAnimation) ||
      !(animation.effect instanceof KeyframeEffect) ||
      animation.timeline !== document.timeline ||
      animation.playState !== "running" ||
      animation.effect.getTiming().iterations !== Infinity ||
      !isSpinner(animation.effect, animation.animationName)
    )
      return;

    const frames = animation.effect.getKeyframes();
    if (frames.some((frame) => frame.easing !== "linear")) {
      animation.effect.setKeyframes(
        frames.map((frame) => ({ ...frame, easing: "linear" })),
      );
    }
    const timing = animation.effect.getTiming();
    if (
      timing.duration !== 1000 ||
      timing.easing !== "linear" ||
      timing.delay !== 0 ||
      timing.endDelay !== 0 ||
      timing.iterationStart !== 0 ||
      timing.direction !== "normal"
    ) {
      animation.effect.updateTiming({
        duration: 1000,
        easing: "linear",
        iterations: Infinity,
        delay: 0,
        endDelay: 0,
        iterationStart: 0,
        direction: "normal",
      });
    }
    if (animation.playbackRate !== 1) animation.playbackRate = 1;
    if (animation.startTime !== 0) animation.startTime = 0;
  }

  function synchronizeExisting(): void {
    for (const animation of document.getAnimations()) synchronize(animation);
  }

  function onAnimationStart(event: AnimationEvent): void {
    if (!(event.target instanceof Element)) return;
    for (const animation of event.target.getAnimations({
      subtree: !!event.pseudoElement,
    })) {
      if (
        animation.effect instanceof KeyframeEffect &&
        animation.effect.target === event.target
      )
        synchronize(animation);
    }
  }

  document.addEventListener("animationstart", onAnimationStart, true);
  reducedMotion.addEventListener("change", synchronizeExisting);
  synchronizeExisting();
  return () => {
    document.removeEventListener("animationstart", onAnimationStart, true);
    reducedMotion.removeEventListener("change", synchronizeExisting);
  };
}
