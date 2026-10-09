// Fullscreen API with the WebKit prefix. iPhone Safari offers neither, and an installed fullscreen web app is
// already fullscreen, so both report unavailable and the settings row stays hidden.
type FsDocument = Document & {
  webkitFullscreenElement?: Element | null
  webkitFullscreenEnabled?: boolean
  webkitExitFullscreen?: () => Promise<void> | void
}
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void }

const doc = () => document as FsDocument

export function isFullscreen(): boolean {
  return !!(doc().fullscreenElement ?? doc().webkitFullscreenElement)
}

export function fullscreenAvailable(): boolean {
  if (typeof document === 'undefined') return false
  if (window.matchMedia?.('(display-mode: fullscreen)').matches) return false
  return !!(doc().fullscreenEnabled || doc().webkitFullscreenEnabled)
}

/** Enters or leaves fullscreen; must run inside a user gesture. Resolves to the state afterwards. */
export async function toggleFullscreen(): Promise<boolean> {
  try {
    if (isFullscreen()) await (doc().exitFullscreen?.() ?? doc().webkitExitFullscreen?.())
    else {
      const root = document.documentElement as FsElement
      await (root.requestFullscreen?.({ navigationUI: 'hide' }) ?? root.webkitRequestFullscreen?.())
    }
  } catch { /* refused (no gesture, or blocked by policy): the state below tells the caller */ }
  return isFullscreen()
}
