const TAURI_LOCALHOST = 'tauri.localhost'

function hasTauriInternals() {
  if (typeof window === 'undefined') return false

  const tauriWindow = window as Window & typeof globalThis & {
    __TAURI_INTERNALS__?: {
      invoke?: unknown
    }
  }

  return typeof tauriWindow.__TAURI_INTERNALS__ !== 'undefined'
}

function isDesktopProtocol(protocol: string) {
  return protocol === 'tauri:' || protocol === 'asset:' || protocol === 'file:'
}

function isTauriLikeHostname(hostname: string) {
  return hostname === TAURI_LOCALHOST || hostname.endsWith(`.${TAURI_LOCALHOST}`)
}

function hasTauriUserAgent() {
  if (typeof navigator === 'undefined') return false
  return /\btauri\b/i.test(navigator.userAgent)
}

export function isDesktopRuntime() {
  if (typeof window === 'undefined') return false

  if (hasTauriInternals()) {
    return true
  }

  const { protocol, hostname, origin } = window.location
  return (
    isDesktopProtocol(protocol) ||
    isTauriLikeHostname(hostname) ||
    origin.includes(TAURI_LOCALHOST) ||
    hasTauriUserAgent()
  )
}
