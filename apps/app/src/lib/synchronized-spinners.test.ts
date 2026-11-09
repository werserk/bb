// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSynchronizedSpinners } from "./synchronized-spinners";

class TestEffect {
  pseudoElement: string | null = null;
  timing: EffectTiming = {
    duration: 900,
    easing: "ease-in",
    delay: 20,
    endDelay: 0,
    iterations: Infinity,
    iterationStart: 0,
    direction: "normal",
  };
  frames: Keyframe[] = [{ transform: "none" }, { transform: "rotate(360deg)" }];
  updateTiming = vi.fn((timing: EffectTiming) =>
    Object.assign(this.timing, timing),
  );
  setKeyframes = vi.fn((frames: Keyframe[]) => {
    this.frames = frames;
  });
  constructor(public target: Element) {}
  getTiming() {
    return this.timing;
  }
  getKeyframes() {
    return this.frames;
  }
}

class TestAnimation {
  startTime: number | null = 237;
  playbackRate = 1;
  playState = "running";
  timeline = document.timeline;
  constructor(
    public animationName: string,
    public effect: TestEffect,
  ) {}
}

let animations: TestAnimation[];
let motion: MediaQueryList;
let uninstall: (() => void) | undefined;

function spinner(name = "spin", className = "animate-spin") {
  const target = document.createElement("div");
  target.className = className;
  target.setAttribute("data-state", "working");
  document.body.append(target);
  const animation = new TestAnimation(name, new TestEffect(target));
  animations.push(animation);
  Object.defineProperty(target, "getAnimations", {
    value: vi.fn(() =>
      animations.filter((item) => item.effect.target === target),
    ),
  });
  return animation;
}

function start(animation: TestAnimation, pseudoElement = "") {
  const event = new Event("animationstart", { bubbles: true });
  Object.defineProperties(event, {
    animationName: { value: animation.animationName },
    pseudoElement: { value: pseudoElement },
  });
  animation.effect.target.dispatchEvent(event);
}

beforeEach(() => {
  animations = [];
  motion = Object.assign(new EventTarget(), {
    matches: false,
  }) as MediaQueryList;
  vi.stubGlobal("CSSAnimation", TestAnimation);
  vi.stubGlobal("KeyframeEffect", TestEffect);
  vi.spyOn(window, "matchMedia").mockReturnValue(motion);
  Object.defineProperty(document, "getAnimations", {
    configurable: true,
    value: vi.fn(() => animations),
  });
});

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  document.body.replaceChildren();
  Reflect.deleteProperty(document, "getAnimations");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("synchronized spinners", () => {
  it("aligns existing core and scoped plugin spinners to the document origin", () => {
    const core = spinner();
    const plugin = spinner("wp-mark-spin-scoped-abc", "wp-status-mark");
    plugin.playbackRate = 2;
    uninstall = installSynchronizedSpinners();
    for (const animation of [core, plugin]) {
      expect(animation.startTime).toBe(0);
      expect(animation.playbackRate).toBe(1);
      expect(animation.effect.timing).toMatchObject({
        duration: 1000,
        easing: "linear",
        delay: 0,
        iterations: Infinity,
      });
    }
  });

  it("normalizes CSS per-keyframe easing without changing rotation geometry", () => {
    const core = spinner();
    core.effect.frames = [
      { transform: "none", easing: "ease-in" },
      { transform: "rotate(360deg)", easing: "ease-in" },
    ];
    uninstall = installSynchronizedSpinners();
    expect(core.effect.frames).toEqual([
      { transform: "none", easing: "linear" },
      { transform: "rotate(360deg)", easing: "linear" },
    ]);
  });

  it("recognizes scoped individual rotate keyframes on utility targets", () => {
    const core = spinner("scoped-spin");
    core.effect.frames = [{ rotate: "0deg" }, { rotate: "360deg" }];
    uninstall = installSynchronizedSpinners();
    expect(core.startTime).toBe(0);
  });

  it.each(["rotate(180deg)", "translateX(10px) rotate(360deg)"])(
    "leaves other scoped transforms alone: %s",
    (transform) => {
      const other = spinner("scoped-other", "wp-status-mark");
      other.effect.frames[1] = { transform };
      uninstall = installSynchronizedSpinners();
      expect(other.startTime).toBe(237);
      expect(other.effect.updateTiming).not.toHaveBeenCalled();
    },
  );

  it("aligns staggered mounts and replacement animations after working re-entry", () => {
    uninstall = installSynchronizedSpinners();
    const core = spinner();
    start(core);
    const plugin = spinner("wp-mark-spin", "wp-status-mark");
    start(plugin);
    plugin.startTime = 1500;
    start(plugin);
    expect(core.startTime).toBe(0);
    expect(plugin.startTime).toBe(0);
  });

  it("handles pseudo elements without changing descendant animations", () => {
    uninstall = installSynchronizedSpinners();
    const pseudo = spinner("scoped-spin");
    pseudo.effect.pseudoElement = "::before";
    const child = spinner();
    vi.mocked(pseudo.effect.target.getAnimations).mockReturnValue([
      pseudo,
      child,
    ] as unknown as Animation[]);
    start(pseudo, "::before");
    expect(pseudo.startTime).toBe(0);
    expect(child.startTime).toBe(237);
  });

  it("preserves unrelated animations, transitions, finite spins and paused state", () => {
    const unrelated = spinner("pulse");
    unrelated.effect.frames = [{ opacity: 0 }, { opacity: 1 }];
    const mixed = spinner("scoped-other", "wp-status-mark");
    mixed.effect.frames[1] = { transform: "rotate(360deg)", opacity: 0.5 };
    const idle = spinner("wp-mark-spin", "wp-status-mark");
    idle.effect.target.setAttribute("data-state", "ready");
    const finite = spinner();
    finite.effect.timing.iterations = 1;
    const paused = spinner();
    paused.playState = "paused";
    const transition = spinner();
    Object.setPrototypeOf(transition, Object.prototype);
    uninstall = installSynchronizedSpinners();
    for (const animation of [
      unrelated,
      mixed,
      idle,
      finite,
      paused,
      transition,
    ]) {
      expect(animation.startTime).toBe(237);
      expect(animation.effect.updateTiming).not.toHaveBeenCalled();
    }
    expect(paused.playState).toBe("paused");
  });

  it("leaves reduced motion alone and synchronizes when motion is restored", () => {
    Object.assign(motion, { matches: true });
    const core = spinner();
    uninstall = installSynchronizedSpinners();
    start(core);
    expect(core.startTime).toBe(237);
    Object.assign(motion, { matches: false });
    motion.dispatchEvent(new Event("change"));
    expect(core.startTime).toBe(0);
  });

  it("does not repeatedly update timing or scan the document on animation starts", () => {
    const core = spinner();
    uninstall = installSynchronizedSpinners();
    start(core);
    start(core);
    expect(core.effect.updateTiming).toHaveBeenCalledTimes(1);
    expect(document.getAnimations).toHaveBeenCalledTimes(1);
    uninstall();
    core.startTime = 600;
    start(core);
    expect(core.startTime).toBe(600);
  });

  it("ignores spinners on another timeline and tolerates missing Web Animations", () => {
    const core = spinner();
    Object.assign(core, { timeline: {} });
    uninstall = installSynchronizedSpinners();
    expect(core.startTime).toBe(237);
    uninstall();
    vi.stubGlobal("CSSAnimation", undefined);
    expect(() => installSynchronizedSpinners()()).not.toThrow();
  });
});
