// A minimal element builder for the developer panel (no framework, no innerHTML: every string goes in as text).
type Attr = string | number | boolean | undefined | null

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, Attr> = {}, ...kids: (Node | string | null)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue
    el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const kid of kids) if (kid !== null) el.append(kid)
  return el
}
