import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'
import '@fontsource/manrope/latin-400.css'
import '@fontsource/manrope/latin-500.css'
import '@fontsource/manrope/latin-700.css'
import '@fontsource/cormorant-garamond/latin-600.css'
import '@fontsource/cormorant-garamond/latin-700.css'
import './index.css'

import { MantineProvider, createTheme, localStorageColorSchemeManager } from '@mantine/core'
import { Notifications } from '@mantine/notifications'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { isDesktopRuntime } from './lib/runtime'

const colorSchemeManager = localStorageColorSchemeManager({
  key: 'ai-inbox-color-scheme',
})

const theme = createTheme({
  fontFamily: 'Manrope, Segoe UI Variable Text, PingFang SC, Microsoft YaHei, sans-serif',
  headings: {
    fontFamily: 'Cormorant Garamond, Songti SC, serif',
    fontWeight: '700',
  },
  defaultRadius: 'xl',
  primaryColor: 'cyan',
  primaryShade: 6,
})

async function cleanupDesktopWebCaches() {
  if (!isDesktopRuntime()) return

  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations()
      await Promise.all(registrations.map((registration) => registration.unregister()))
    } catch {
      // Ignore browser-side cleanup failures on desktop startup.
    }
  }

  if (typeof window !== 'undefined' && 'caches' in window) {
    try {
      const keys = await window.caches.keys()
      await Promise.all(keys.map((key) => window.caches.delete(key)))
    } catch {
      // Ignore cache cleanup failures on desktop startup.
    }
  }
}

void cleanupDesktopWebCaches()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider
      theme={theme}
      defaultColorScheme="light"
      colorSchemeManager={colorSchemeManager}
    >
      <Notifications position="top-right" />
      <App />
    </MantineProvider>
  </StrictMode>,
)
