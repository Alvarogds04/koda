// Source: reference/coucou windows/src/core/anim.ts @434d6a2b — Copyright (c) 2026 Louis Raillé, MIT
var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
const Ease = {
  out: (t) => 1 - Math.pow(1 - t, 3),
  inOut: (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  back: (t) => {
    const c1 = 1.7;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  lin: (t) => t,
  easeIn: (t) => t * t * t
};
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const seg = (t, a, b) => clamp((t - a) / (b - a), 0, 1);
function cubicBezier(x1, y1, x2, y2) {
  const cx = (t) => (1 - t) ** 2 * 3 * t * x1 + 3 * (1 - t) * t * t * x2 + t ** 3;
  const cy = (t) => (1 - t) ** 2 * 3 * t * y1 + 3 * (1 - t) * t * t * y2 + t ** 3;
  return (x) => {
    let lo = 0;
    let hi = 1;
    let t = x;
    for (let i = 0; i < 12; i++) {
      const v = cx(t);
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return cy(t);
  };
}
const closeCurve = cubicBezier(0.45, 0, 0.2, 1);
class Spring {
  constructor(value, response = 0.5, damping = 0.72) {
    __publicField(this, "value");
    __publicField(this, "target");
    __publicField(this, "velocity", 0);
    __publicField(this, "omega");
    __publicField(this, "zeta");
    this.value = value;
    this.target = value;
    this.omega = 2 * Math.PI / response;
    this.zeta = damping;
  }
  configure(response, damping) {
    this.omega = 2 * Math.PI / response;
    this.zeta = damping;
  }
  set(value) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
  }
  get settled() {
    return Math.abs(this.target - this.value) < 0.01 && Math.abs(this.velocity) < 0.05;
  }
  step(dt) {
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const acc = this.omega * this.omega * (this.target - this.value) - 2 * this.zeta * this.omega * this.velocity;
      this.velocity += acc * h;
      this.value += this.velocity * h;
    }
  }
}
class Tracked {
  constructor(value) {
    __publicField(this, "spring");
    __publicField(this, "curveFrom", 0);
    __publicField(this, "curveTo", 0);
    __publicField(this, "curveStart", 0);
    __publicField(this, "curveDur", 0);
    __publicField(this, "mode", "idle");
    this.spring = new Spring(value);
  }
  get value() {
    return this.spring.value;
  }
  get animating() {
    return this.mode !== "idle";
  }
  jump(v) {
    this.spring.set(v);
    this.mode = "idle";
  }
  /** Spring to `v` (open / grow). */
  springTo(v, response = 0.5, damping = 0.72) {
    this.spring.configure(response, damping);
    this.spring.target = v;
    this.mode = "spring";
  }
  /** Timed curve to `v` (close / shrink), no overshoot. */
  curveTowards(v, durationMs = 340, now = performance.now()) {
    this.curveFrom = this.spring.value;
    this.curveTo = v;
    this.curveStart = now;
    this.curveDur = durationMs;
    this.spring.target = v;
    this.spring.velocity = 0;
    this.mode = "curve";
  }
  step(dt, now = performance.now()) {
    if (this.mode === "spring") {
      this.spring.step(dt);
      if (this.spring.settled) {
        this.spring.value = this.spring.target;
        this.spring.velocity = 0;
        this.mode = "idle";
      }
    } else if (this.mode === "curve") {
      const p = clamp((now - this.curveStart) / this.curveDur, 0, 1);
      this.spring.value = lerp(this.curveFrom, this.curveTo, closeCurve(p));
      if (p >= 1) {
        this.spring.velocity = 0;
        this.mode = "idle";
      }
    }
  }
}
export {
  Ease,
  Spring,
  Tracked,
  clamp,
  closeCurve,
  cubicBezier,
  lerp,
  seg
};
