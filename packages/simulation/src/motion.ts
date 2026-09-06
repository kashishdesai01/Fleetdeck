// Synthetic motion in map units, not a calibrated physical vehicle model.
export interface Point {
  x: number;
  y: number;
}
export interface Motion {
  waypoints: Point[];
  rng: number;
  cruise: number;
  congestion: number;
  pause: number;
  elapsed: number;
}
export function seedOf(value: string): number {
  let seed = 2166136261;
  for (const char of value) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  return seed >>> 0;
}
export function random(state: { rng: number }): number {
  state.rng = (Math.imul(1664525, state.rng) + 1013904223) >>> 0;
  return state.rng / 4294967296;
}
export function route(from: Point, to: Point): Point[] {
  const points = [{ x: from.x, y: 285 }, { x: to.x, y: 285 }, { ...to }];
  let previous = from;
  return points.filter((point) => {
    const keep = Math.hypot(point.x - previous.x, point.y - previous.y) > 0.001;
    previous = point;
    return keep;
  });
}
export function routeFeatures(from: Point, to: Point): { distance: number; turns: number } {
  const points = route(from, to);
  let previous = from,
    distance = 0;
  for (const point of points) {
    distance += Math.hypot(point.x - previous.x, point.y - previous.y);
    previous = point;
  }
  return { distance, turns: Math.max(0, points.length - 1) };
}
export function startMotion(from: Point, to: Point, seed: number, congestion: number): Motion {
  const state = { rng: seed };
  const cruise = 19 + random(state) * 9;
  const pause = 0.5 + random(state) * (1.5 + congestion * 5);
  return { waypoints: route(from, to), rng: state.rng, cruise, congestion, pause, elapsed: 0 };
}
export interface Body extends Point {
  battery: number;
  heading: number;
  speed: number;
}
export function stepMotion(body: Body, motion: Motion, duration: number, blocked = false): boolean {
  // Fixed substeps make offline trace generation and the live simulator share dynamics.
  let remaining = duration;
  while (remaining > 1e-8 && motion.waypoints.length) {
    const dt = Math.min(0.25, remaining);
    remaining -= dt;
    motion.elapsed += dt;
    body.speed = 0;
    if (blocked) continue;
    if (motion.pause > 0) {
      motion.pause = Math.max(0, motion.pause - dt);
      continue;
    }
    if (random(motion) < dt * (0.015 + motion.congestion * 0.12)) {
      motion.pause = 0.5 + random(motion) * (1 + motion.congestion * 5);
      continue;
    }
    const batteryFactor = body.battery < 45 ? 0.65 + body.battery / 130 : 1;
    const speed = motion.cruise * (1 - 0.55 * motion.congestion) * batteryFactor;
    let distance = speed * dt;
    while (distance > 0 && motion.waypoints.length) {
      const point = motion.waypoints[0]!;
      const length = Math.hypot(point.x - body.x, point.y - body.y);
      if (length < 0.001) {
        motion.waypoints.shift();
        continue;
      }
      const moved = Math.min(length, distance);
      body.heading = ((Math.atan2(point.y - body.y, point.x - body.x) * 180) / Math.PI + 360) % 360;
      body.x += ((point.x - body.x) / length) * moved;
      body.y += ((point.y - body.y) / length) * moved;
      body.battery = Math.max(0, body.battery - moved * 0.002);
      body.speed = speed;
      distance -= moved;
      if (moved >= length) {
        motion.waypoints.shift();
        if (motion.waypoints.length) {
          motion.pause = 0.5 + random(motion);
          break;
        }
      }
    }
  }
  if (!motion.waypoints.length) body.speed = 0;
  return motion.waypoints.length === 0;
}
