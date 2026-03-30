import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import type { EntryRecord, InterpretationRecord } from './types'

export type ReminderInference =
  | {
      status: 'none'
      reminderAt: null
      reason: null
    }
  | {
      status: 'scheduled'
      reminderAt: string
      reason: null
    }
  | {
      status: 'past-due' | 'invalid-time'
      reminderAt: null
      reason: string
    }

const CHINESE_DIGITS: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
}

const WEEKDAY_MAP: Record<string, number> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
}

const PERIOD_PATTERN = '(凌晨|早上|上午|中午|下午|晚上|今晚)?'
const HOUR_PATTERN = '([零一二两三四五六七八九十\\d]{1,3})'
const MINUTE_PATTERN = '([零一二两三四五六七八九十\\d]{1,3})'
const TIME_PATTERN = new RegExp(
  `${PERIOD_PATTERN}\\s*${HOUR_PATTERN}\\s*(?:点|:|：)\\s*(?:${MINUTE_PATTERN}\\s*分?)?\\s*(半|一刻|三刻)?`,
)

let notificationPermissionPromise: Promise<boolean> | null = null

function convertChineseDigits(input: string) {
  const normalized = input.trim()
  if (!normalized) return Number.NaN
  if (/^\d+$/.test(normalized)) return Number(normalized)
  if (normalized === '十') return 10

  if (normalized.includes('十')) {
    const [left, right] = normalized.split('十')
    const tens = left ? CHINESE_DIGITS[left] ?? 0 : 1
    const units = right ? CHINESE_DIGITS[right] ?? 0 : 0
    return tens * 10 + units
  }

  return normalized.split('').reduce((value, char) => value * 10 + (CHINESE_DIGITS[char] ?? 0), 0)
}

function setTimeParts(base: Date, hour: number, minute: number) {
  const date = new Date(base)
  date.setSeconds(0, 0)
  date.setHours(hour, minute, 0, 0)
  return date
}

function nextWeekday(base: Date, weekday: number, offsetWeeks = 0) {
  const date = new Date(base)
  date.setHours(0, 0, 0, 0)
  const current = date.getDay()
  let diff = weekday - current
  if (diff < 0 || (diff === 0 && offsetWeeks > 0)) diff += 7
  diff += offsetWeeks * 7
  date.setDate(date.getDate() + diff)
  return date
}

function hasReminderIntent(text: string) {
  return (
    /(今天|明天|后天|今晚|早上|上午|中午|下午|晚上|凌晨|本周|这周|下周|周[一二三四五六日天]|星期[一二三四五六日天])/.test(text) ||
    /(\d{1,2}[:：]\d{2}|[零一二两三四五六七八九十\d]{1,3}点)/.test(text)
  )
}

function parseClock(text: string) {
  const match = text.match(TIME_PATTERN)
  if (!match) return null

  const period = match[1] ?? ''
  let hour = convertChineseDigits(match[2])
  let minute = 0

  if (match[4] === '半') {
    minute = 30
  } else if (match[4] === '一刻') {
    minute = 15
  } else if (match[4] === '三刻') {
    minute = 45
  } else if (match[3]) {
    minute = convertChineseDigits(match[3])
  }

  if (Number.isNaN(hour) || Number.isNaN(minute)) return null

  if (period === '下午' || period === '晚上' || period === '今晚') {
    if (hour < 12) hour += 12
  } else if (period === '中午') {
    if (hour < 11) hour += 12
  } else if (period === '凌晨' && hour === 12) {
    hour = 0
  }

  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

function parseDatePart(text: string, now: Date) {
  if (/今天/.test(text)) return new Date(now)
  if (/明天/.test(text)) return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  if (/后天/.test(text)) return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2)

  const absoluteDate = text.match(/(?:(\d{4})[年/-])?\s*(\d{1,2})[月/-](\d{1,2})[日号]?/)
  if (absoluteDate) {
    const year = absoluteDate[1] ? Number(absoluteDate[1]) : now.getFullYear()
    return new Date(year, Number(absoluteDate[2]) - 1, Number(absoluteDate[3]))
  }

  const nextWeek = text.match(/下周([一二三四五六日天])/)
  if (nextWeek) return nextWeekday(now, WEEKDAY_MAP[nextWeek[1]], 1)

  const thisWeek = text.match(/(?:本周|这周|周|星期)([一二三四五六日天])/)
  if (thisWeek) {
    const date = nextWeekday(now, WEEKDAY_MAP[thisWeek[1]])
    if (date < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
      date.setDate(date.getDate() + 7)
    }
    return date
  }

  return null
}

export function inferReminderFromText(content: string, now = new Date()): ReminderInference {
  const text = content.trim()
  if (!hasReminderIntent(text)) {
    return {
      status: 'none',
      reminderAt: null,
      reason: null,
    }
  }

  const clock = parseClock(text)
  if (!clock) {
    return {
      status: 'invalid-time',
      reminderAt: null,
      reason: '检测到时间意图，但没有识别出明确的提醒时间。',
    }
  }

  const datePart = parseDatePart(text, now) ?? new Date(now)
  const reminderAt = setTimeParts(datePart, clock.hour, clock.minute)

  if (Number.isNaN(reminderAt.getTime())) {
    return {
      status: 'invalid-time',
      reminderAt: null,
      reason: '提醒时间格式无效，请换一种时间表达。',
    }
  }

  if (reminderAt.getTime() <= now.getTime()) {
    return {
      status: 'past-due',
      reminderAt: null,
      reason: '识别到了时间，但它已经早于当前时间，所以没有创建提醒。',
    }
  }

  return {
    status: 'scheduled',
    reminderAt: reminderAt.toISOString(),
    reason: null,
  }
}

async function ensureNotificationPermission() {
  if (!notificationPermissionPromise) {
    notificationPermissionPromise = (async () => {
      if (await isPermissionGranted()) return true
      return (await requestPermission()) === 'granted'
    })()
  }

  return notificationPermissionPromise
}

export async function requestReminderPermission() {
  notificationPermissionPromise = null
  if (await isPermissionGranted()) {
    notificationPermissionPromise = Promise.resolve(true)
    return true
  }

  const granted = (await requestPermission()) === 'granted'
  notificationPermissionPromise = Promise.resolve(granted)
  return granted
}

export async function scheduleEntryReminder(entry: EntryRecord, interpretation: InterpretationRecord | null) {
  void interpretation

  if (!entry.reminderAt || entry.completedAt) {
    return {
      reminderNotificationId: null,
      reminderScheduledAt: null,
      reminderTriggeredAt: null,
      reminderStatus: 'idle' as const,
      reminderReason: null,
    }
  }

  const reminderDate = new Date(entry.reminderAt)
  if (Number.isNaN(reminderDate.getTime())) {
    return {
      reminderNotificationId: null,
      reminderScheduledAt: null,
      reminderTriggeredAt: null,
      reminderStatus: 'invalid-time' as const,
      reminderReason: '提醒时间格式无效，请重新设置一个可识别的日期和时间。',
    }
  }

  const permissionGranted = await ensureNotificationPermission()
  if (!permissionGranted) {
    return {
      reminderNotificationId: null,
      reminderScheduledAt: entry.reminderScheduledAt ?? null,
      reminderTriggeredAt: entry.reminderTriggeredAt ?? null,
      reminderStatus: 'permission-denied' as const,
      reminderReason: '系统通知权限未开启，请先允许 AI Inbox 发送通知。',
    }
  }

  if (entry.reminderTriggeredAt && reminderDate.getTime() <= Date.now()) {
    return {
      reminderNotificationId: null,
      reminderScheduledAt: entry.reminderScheduledAt ?? entry.reminderTriggeredAt,
      reminderTriggeredAt: entry.reminderTriggeredAt,
      reminderStatus: 'triggered' as const,
      reminderReason: null,
    }
  }

  return {
    reminderNotificationId: null,
    reminderScheduledAt: entry.reminderScheduledAt ?? new Date().toISOString(),
    reminderTriggeredAt: reminderDate.getTime() > Date.now() ? null : entry.reminderTriggeredAt ?? null,
    reminderStatus: 'scheduled' as const,
    reminderReason: null,
  }
}

export function isReminderDue(entry: EntryRecord, now = Date.now()) {
  if (!entry.reminderAt || entry.completedAt) return false
  if (entry.reminderStatus !== 'scheduled') return false
  if (entry.reminderTriggeredAt) return false

  const reminderTime = new Date(entry.reminderAt).getTime()
  return Number.isFinite(reminderTime) && reminderTime <= now
}

export async function triggerEntryReminder(entry: EntryRecord, interpretation: InterpretationRecord | null) {
  const permissionGranted = await ensureNotificationPermission()
  if (!permissionGranted) {
    return {
      reminderNotificationId: null,
      reminderScheduledAt: entry.reminderScheduledAt ?? null,
      reminderTriggeredAt: null,
      reminderStatus: 'permission-denied' as const,
      reminderReason: '系统通知权限未开启，请先允许 AI Inbox 发送通知。',
    }
  }

  sendNotification({
    title: 'AI Inbox 提醒',
    body: interpretation?.displayTitle ?? entry.content,
  })

  return {
    reminderNotificationId: null,
    reminderScheduledAt: entry.reminderScheduledAt ?? new Date().toISOString(),
    reminderTriggeredAt: new Date().toISOString(),
    reminderStatus: 'triggered' as const,
    reminderReason: null,
  }
}

export async function triggerReminderTest(entry: EntryRecord, interpretation: InterpretationRecord | null) {
  const permissionGranted = await ensureNotificationPermission()
  if (!permissionGranted) {
    return {
      ok: false,
      reason: '系统通知权限未开启，请先允许 AI Inbox 发送通知。',
    }
  }

  sendNotification({
    title: 'AI Inbox 提醒',
    body: interpretation?.displayTitle ?? entry.content,
  })

  return {
    ok: true,
    reason: null,
  }
}
