// World generation as resumable steps: a generator yields between stages so a caller can hand the thread back
// (the browser paints the title while the world builds) without changing a single computation or its order.
export type Steps<T> = Generator<void, T, void>

/** Runs every step back to back; the result is what the plain function would have returned. */
export function drain<T>(steps: Steps<T>): T {
  for (;;) {
    const r = steps.next()
    if (r.done) return r.value
  }
}
