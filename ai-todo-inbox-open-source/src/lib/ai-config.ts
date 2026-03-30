import { isDesktopRuntime } from './runtime'

export type AiRuntimeSettings = {
  baseUrl: string
  apiKey: string
  model: string
}

const STORAGE_KEY = 'ai-inbox-ai-settings'

function readEnv(name: string) {
  const value = import.meta.env[name] as string | undefined
  return value?.trim() ?? ''
}

function normalizeValue(value: string | null | undefined) {
  return value?.trim() ?? ''
}

function isRelativeProxy(value: string) {
  return value.startsWith('/')
}

const defaultAiSettings: AiRuntimeSettings = {
  baseUrl: readEnv('VITE_AI_BASE_URL'),
  apiKey: readEnv('VITE_AI_API_KEY'),
  model: readEnv('VITE_AI_MODEL') || 'your-model-name',
}

export const aiSettings: AiRuntimeSettings = { ...defaultAiSettings }

const listeners = new Set<() => void>()
let initialized = false

function notifyListeners() {
  listeners.forEach((listener) => listener())
}

function persistSettings() {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(aiSettings))
  } catch {
    // Ignore storage write failures so the in-memory config can still work.
  }
}

function applySettings(next: Partial<AiRuntimeSettings>) {
  aiSettings.baseUrl = normalizeValue(next.baseUrl ?? aiSettings.baseUrl)
  aiSettings.apiKey = normalizeValue(next.apiKey ?? aiSettings.apiKey)
  aiSettings.model = normalizeValue(next.model ?? aiSettings.model) || defaultAiSettings.model
}

function readStoredSettings() {
  if (typeof window === 'undefined') return null

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null

    const parsed = JSON.parse(raw) as Partial<AiRuntimeSettings>
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

function repairDesktopSettingsFromDefaults() {
  if (!isDesktopRuntime()) return false
  if (!isRelativeProxy(aiSettings.baseUrl)) return false
  if (!defaultAiSettings.baseUrl || isRelativeProxy(defaultAiSettings.baseUrl)) return false

  aiSettings.baseUrl = defaultAiSettings.baseUrl

  if (!aiSettings.apiKey && defaultAiSettings.apiKey) {
    aiSettings.apiKey = defaultAiSettings.apiKey
  }

  if (!aiSettings.model) {
    aiSettings.model = defaultAiSettings.model
  }

  persistSettings()
  return true
}

export function loadAiSettings() {
  if (!initialized) {
    initialized = true

    const storedSettings = readStoredSettings()
    if (storedSettings) {
      applySettings(storedSettings)
    }

    repairDesktopSettingsFromDefaults()
  }

  return { ...aiSettings }
}

export function getAiSettings() {
  return { ...loadAiSettings() }
}

export function getDefaultAiSettings() {
  return { ...defaultAiSettings }
}

export function saveAiSettings(next: AiRuntimeSettings) {
  applySettings(next)
  persistSettings()
  notifyListeners()
  return { ...aiSettings }
}

export function resetAiSettings() {
  applySettings(defaultAiSettings)

  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(STORAGE_KEY)
  }

  repairDesktopSettingsFromDefaults()
  notifyListeners()
  return { ...aiSettings }
}

export function subscribeAiSettings(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

loadAiSettings()
