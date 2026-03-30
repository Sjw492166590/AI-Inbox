import {
  ActionIcon,
  Badge,
  Button,
  Collapse,
  Container,
  Drawer,
  Group,
  HoverCard,
  Indicator,
  Modal,
  PasswordInput,
  Paper,
  Popover,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
  Title,
  useComputedColorScheme,
  useMantineColorScheme,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  IconBrain,
  IconBellRinging,
  IconCheck,
  IconChecklist,
  IconClockHour4,
  IconChevronDown,
  IconChevronUp,
  IconMoonStars,
  IconNotes,
  IconRotateClockwise2,
  IconSend2,
  IconSparkles,
  IconStack2,
  IconSettings,
  IconSunHigh,
  IconTrash,
} from '@tabler/icons-react'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { aiSettings, buildAiErrorMessage, classifyEntry, hasAiConfig, summarizeTopic } from './lib/ai'
import {
  getAiSettings,
  getDefaultAiSettings,
  resetAiSettings,
  saveAiSettings,
  subscribeAiSettings,
  type AiRuntimeSettings,
} from './lib/ai-config'
import { db } from './lib/db'
import {
  inferReminderFromText,
  isReminderDue,
  requestReminderPermission,
  scheduleEntryReminder,
  triggerEntryReminder,
  triggerReminderTest,
} from './lib/reminders'
import type {
  AppItem,
  EntryRecord,
  EntryType,
  InterpretationRecord,
  TopicBundle,
  TopicCandidate,
  TopicKind,
  TopicRecord,
  TopicSummaryInput,
} from './lib/types'

type ActiveView = 'plan' | 'note'
type LayoutMode = 'full' | 'compact' | 'minimal'

type QueueJob = {
  entryId: string
  content: string
  createdAt: string
  preferredType: EntryType | null
}

const MotionDiv = motion.div
const MAX_CONCURRENT_JOBS = 3
const composerTypeOptions = ['auto', 'task', 'note'] as const

type ComposerType = (typeof composerTypeOptions)[number]

const composerTypeLabels: Record<ComposerType, string> = {
  auto: '自动',
  task: '计划',
  note: '笔记',
}

const viewMeta: Record<ActiveView, { label: string; title: string; description: string }> = {
  plan: { label: '计划', title: '计划', description: '所有待推进的事项会按主题聚合在这里。' },
  note: { label: '笔记', title: '笔记', description: '总结、日常记录和零散想法统一沉淀到这里。' },
}

const typeLabels: Record<EntryType, string> = {
  task: '计划',
  analysis: '笔记',
  journal: '笔记',
  note: '笔记',
}

const topicKindLabels: Record<TopicKind, string> = {
  plan: '计划主题',
  insight: '笔记主题',
  'journal-thread': '笔记主题',
  mixed: '笔记主题',
}

const processingLabels: Record<EntryRecord['processingState'], string> = {
  pending: '排队中',
  processing: '处理中',
  classified: '已整理',
  error: '整理失败',
}

const summaryStateLabels: Record<NonNullable<TopicRecord['summaryState']>, string> = {
  idle: '已同步',
  queued: '待更新',
  updating: '更新中',
  error: '更新失败',
}

function timeLabel(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function padDatePart(value: number) {
  return String(value).padStart(2, '0')
}

function toDateInputValue(value: string | null | undefined) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`
}

function toTimeInputValue(value: string | null | undefined) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}`
}

function getDefaultReminderDraft(now = new Date()) {
  const draft = new Date(now)
  draft.setSeconds(0, 0)
  const remainder = draft.getMinutes() % 30
  const nextStep = remainder === 0 ? 30 : 30 - remainder
  draft.setMinutes(draft.getMinutes() + nextStep)
  return {
    date: toDateInputValue(draft.toISOString()),
    time: toTimeInputValue(draft.toISOString()),
  }
}

function buildReminderAt(dateValue: string, timeValue: string) {
  if (!dateValue || !timeValue) return null

  const [year, month, day] = dateValue.split('-').map(Number)
  const [hour, minute] = timeValue.split(':').map(Number)
  if ([year, month, day, hour, minute].some((value) => Number.isNaN(value))) return null

  const reminderDate = new Date(year, month - 1, day, hour, minute, 0, 0)
  return Number.isNaN(reminderDate.getTime()) ? null : reminderDate.toISOString()
}

function generateId() {
  return crypto.randomUUID()
}

const PLAN_TOPIC_CLUSTERS = [
  { key: 'planning', label: '方案设计', patterns: [/调研|研究|分析|架构|选型|方案|设计|规划|评估|梳理/] },
  { key: 'delivery', label: '开发推进', patterns: [/开发|实现|联调|对接|编码|接口|新增|补充|改造|重构|替换|更新/] },
  { key: 'release', label: '发布推进', patterns: [/发版|发布|上线|部署|提测|验收/] },
  { key: 'fix', label: '问题处理', patterns: [/修复|排查|故障|异常|问题|bug|优化/i] },
] as const

const PLAN_TOPIC_NOISE_PATTERNS = [
  /工作|任务|事项|项目|相关|内容|方向|需求|计划|安排|推进|跟进|完成/g,
  /调研|研究|分析|架构|选型|方案|设计|规划|评估|梳理/g,
  /开发|实现|联调|对接|编码|接口|新增|补充|改造|重构|替换|更新/g,
  /发版|发布|上线|部署|提测|验收/g,
  /修复|排查|故障|异常|问题|优化/g,
]

function squeezeWhitespace(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function normalizeForComparison(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, '')
}

function hasDisplayRewrite(displayTitle: string | null | undefined, rawContent: string) {
  if (!displayTitle) return false
  return normalizeForComparison(displayTitle) !== normalizeForComparison(rawContent)
}

function normalizeTopicName(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function detectPlanTopicCluster(value: string) {
  const normalized = normalizeTopicName(value)
  return PLAN_TOPIC_CLUSTERS.find((cluster) => cluster.patterns.some((pattern) => pattern.test(normalized))) ?? null
}

function stripPlanTopicSubject(value: string) {
  let subject = value
    .replace(/[()（）[\]【】]/g, ' ')
    .replace(/[^\w\u4e00-\u9fa5]+/g, ' ')

  for (const pattern of PLAN_TOPIC_NOISE_PATTERNS) {
    subject = subject.replace(pattern, ' ')
  }

  return squeezeWhitespace(subject)
}

function buildTopicMergeKey(name: string, kind: TopicKind) {
  if (kind !== 'plan') return `${kind}::${normalizeTopicName(name)}`

  const clusterKey = detectPlanTopicCluster(name)?.key ?? 'general'
  const subject = normalizeTopicName(stripPlanTopicSubject(name))
  const fallback = normalizeTopicName(name)
  return `${kind}::${clusterKey}::${subject || fallback}`
}

function canonicalizeTopicName(name: string, kind: TopicKind) {
  if (kind !== 'plan') return squeezeWhitespace(name)

  const cluster = detectPlanTopicCluster(name)
  const subject = stripPlanTopicSubject(name)
  if (!subject || !cluster) return squeezeWhitespace(name)

  if (cluster.key === 'planning') {
    return `${subject}方案设计`
  }

  return squeezeWhitespace(name)
}

function sortByCreatedAtDesc<T extends { createdAt: string }>(items: T[]) {
  return [...items].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

function sortByCreatedAtAsc<T extends { createdAt: string }>(items: T[]) {
  return [...items].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

function sortByUpdatedAtDesc<T extends { updatedAt: string }>(items: T[]) {
  return [...items].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function sortTopicBundlesByUpdatedAtDesc(items: TopicBundle[]) {
  return [...items].sort((left, right) => right.topic.updatedAt.localeCompare(left.topic.updatedAt))
}

function getTopicCompletionMeta(bundle: TopicBundle) {
  if (bundle.topic.kind !== 'plan') {
    return {
      fullyCompleted: false,
      latestCompletedAt: null as string | null,
    }
  }

  const planItems = bundle.items.filter((item) => item.interpretation?.type === 'task')
  const activeItems = planItems.filter((item) => !isCompletedEntry(item.entry))
  const completedItems = planItems
    .map((item) => item.entry.completedAt ?? null)
    .filter(Boolean) as string[]

  return {
    fullyCompleted: planItems.length > 0 && activeItems.length === 0,
    latestCompletedAt:
      completedItems.length > 0
        ? [...completedItems].sort((left, right) => right.localeCompare(left))[0]
        : null,
  }
}

function sortTopicBundlesForView(items: TopicBundle[], view: ActiveView) {
  if (view !== 'plan') return sortTopicBundlesByUpdatedAtDesc(items)

  return [...items].sort((left, right) => {
    const leftMeta = getTopicCompletionMeta(left)
    const rightMeta = getTopicCompletionMeta(right)

    if (leftMeta.fullyCompleted !== rightMeta.fullyCompleted) {
      return leftMeta.fullyCompleted ? 1 : -1
    }

    if (leftMeta.fullyCompleted && rightMeta.fullyCompleted) {
      const leftCompletedAt = leftMeta.latestCompletedAt ?? ''
      const rightCompletedAt = rightMeta.latestCompletedAt ?? ''
      return rightCompletedAt.localeCompare(leftCompletedAt)
    }

    return right.topic.updatedAt.localeCompare(left.topic.updatedAt)
  })
}

function isPlanTopicKind(kind: TopicKind | null) {
  return kind === 'plan'
}

function isNoteTopicKind(kind: TopicKind | null) {
  return Boolean(kind && kind !== 'plan')
}

function sectionMatches(kind: TopicKind | null, type: EntryType | null, view: ActiveView) {
  if (view === 'plan') return isPlanTopicKind(kind) || (!kind && type === 'task')
  return isNoteTopicKind(kind) || (!kind && Boolean(type) && type !== 'task')
}

function getTypeColor(type: EntryType) {
  return type === 'task' ? 'cyan' : 'orange'
}

function getTopicColor(kind: TopicKind) {
  return kind === 'plan' ? 'cyan' : 'orange'
}

function isCompletedEntry(entry: EntryRecord) {
  return Boolean(entry.completedAt)
}

function getTopicSurfaceClass(kind: TopicKind) {
  return kind === 'plan' ? 'topic-surface topic-surface-plan' : 'topic-surface topic-surface-note'
}

function getSummaryBandClass(kind: TopicKind) {
  return kind === 'plan' ? 'summary-band summary-band-plan' : 'summary-band summary-band-note'
}

function getEntrySurfaceClass(type: EntryType | null, completed = false) {
  if (completed) return 'entry-surface entry-surface-completed'
  return type === 'task' ? 'entry-surface entry-surface-plan' : 'entry-surface entry-surface-note'
}

function getReminderMeta(entry: EntryRecord) {
  if (entry.completedAt) return null

  if (entry.reminderStatus === 'scheduled' && entry.reminderAt) {
    return {
      color: 'violet' as const,
      label: timeLabel(entry.reminderAt),
    }
  }

  if (entry.reminderStatus === 'triggered') {
    return {
      color: 'teal' as const,
      label: '已提醒',
    }
  }

  if (entry.reminderStatus === 'permission-denied') {
    return {
      color: 'orange' as const,
      label: '未开通知',
    }
  }

  if (entry.reminderStatus === 'past-due') {
    return {
      color: 'gray' as const,
      label: '已过期',
    }
  }

  if (entry.reminderStatus === 'invalid-time') {
    return {
      color: 'orange' as const,
      label: '时间未识别',
    }
  }

  return null
}

function getLayoutMode(width: number): LayoutMode {
  if (width <= 760) return 'minimal'
  if (width <= 1180) return 'compact'
  return 'full'
}

function getFallbackEntryType(preferredType?: EntryType | null): EntryType {
  return preferredType === 'task' ? 'task' : 'note'
}

function buildFailedInterpretation(
  entry: Pick<EntryRecord, 'id' | 'content' | 'createdAt' | 'preferredType'>,
  createdAt = new Date().toISOString(),
): InterpretationRecord {
  const fallbackType = getFallbackEntryType(entry.preferredType)
  const manualChosen = Boolean(entry.preferredType)
  const fallbackLabel = fallbackType === 'task' ? '计划' : '笔记'

  return {
    entryId: entry.id,
    type: fallbackType,
    displayTitle: entry.content,
    rationale: manualChosen
      ? `AI 整理失败，已按你手动选择的${fallbackLabel}保存。`
      : 'AI 整理失败，已按默认兜底规则保存到笔记。',
    confidence: manualChosen ? 1 : 0.28,
    topicId: null,
    topicName: null,
    topicKind: fallbackType === 'task' ? 'plan' : null,
    topicSummary: null,
    needsReview: !manualChosen,
    usedAi: false,
    model: null,
    createdAt,
    typeSource: manualChosen ? 'manual' : 'auto',
  }
}

function cloneAiSettingsDraft(source: AiRuntimeSettings): AiRuntimeSettings {
  return {
    baseUrl: source.baseUrl,
    apiKey: source.apiKey,
    model: source.model,
  }
}

function App() {
  const { setColorScheme } = useMantineColorScheme()
  const computedColorScheme = useComputedColorScheme('light')
  const [draft, setDraft] = useState('')
  const [composerType, setComposerType] = useState<ComposerType>('auto')
  const [entries, setEntries] = useState<EntryRecord[]>([])
  const [interpretations, setInterpretations] = useState<InterpretationRecord[]>([])
  const [topics, setTopics] = useState<TopicRecord[]>([])
  const [activeView, setActiveView] = useState<ActiveView>('plan')
  const [inboxOpened, setInboxOpened] = useState(false)
  const [queue, setQueue] = useState<QueueJob[]>([])
  const [activeJobs, setActiveJobs] = useState<QueueJob[]>([])
  const [statusMessage, setStatusMessage] = useState('准备记录')
  const [summaryQueueVersion, setSummaryQueueVersion] = useState(0)
  const [expandedSourceIds, setExpandedSourceIds] = useState<string[]>([])
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined' ? 1320 : window.innerWidth,
  )
  const [reminderEditorEntryId, setReminderEditorEntryId] = useState<string | null>(null)
  const [reminderDraftDate, setReminderDraftDate] = useState('')
  const [reminderDraftTime, setReminderDraftTime] = useState('')
  const [reminderSavingEntryId, setReminderSavingEntryId] = useState<string | null>(null)
  const [aiSettingsOpened, setAiSettingsOpened] = useState(false)
  const [aiSettingsDraft, setAiSettingsDraft] = useState<AiRuntimeSettings>(() => cloneAiSettingsDraft(getAiSettings()))
  const [, setAiSettingsRevision] = useState(0)

  const runningJobIdsRef = useRef<Set<string>>(new Set())
  const finalizeChainRef = useRef<Promise<void>>(Promise.resolve())
  const pendingTopicRefreshesRef = useRef<Set<string>>(new Set())
  const activeTopicRefreshesRef = useRef<Set<string>>(new Set())
  const reconciledTopicsRef = useRef(false)
  const reminderPollingRef = useRef(false)
  const triggeringReminderIdsRef = useRef<Set<string>>(new Set())
  const flushDueRemindersRef = useRef<() => Promise<void>>(async () => {})

  const loadAll = useCallback(async () => {
    const [entryRows, interpretationRows, topicRows] = await Promise.all([
      db.entries.toArray(),
      db.interpretations.toArray(),
      db.topics.toArray(),
    ])
    setEntries(sortByCreatedAtDesc(entryRows))
    setInterpretations(sortByCreatedAtDesc(interpretationRows))
    setTopics(sortByUpdatedAtDesc(topicRows))
  }, [])

  const runInFinalizeQueue = useCallback(async (task: () => Promise<void>) => {
    const previous = finalizeChainRef.current.catch(() => undefined)
    let release!: () => void
    finalizeChainRef.current = new Promise<void>((resolve) => {
      release = resolve
    })

    await previous

    try {
      await task()
    } finally {
      release()
    }
  }, [])

  const queueTopicRefresh = useCallback(async (topicId: string) => {
    pendingTopicRefreshesRef.current.add(topicId)
    const nextState = activeTopicRefreshesRef.current.has(topicId) ? 'updating' : 'queued'
    await db.topics.update(topicId, { summaryState: nextState })
    setSummaryQueueVersion((value) => value + 1)
  }, [])

  const syncEntryReminder = useCallback(async (entryId: string) => {
    const [entry, interpretation] = await Promise.all([db.entries.get(entryId), db.interpretations.get(entryId)])
    if (!entry) return null

    const reminderState = await scheduleEntryReminder(entry, interpretation ?? null)
    await db.entries.update(entryId, reminderState)
    return reminderState
  }, [])

  const recoverFailedEntries = useCallback(async () => {
    const [entryRows, interpretationRows] = await Promise.all([db.entries.toArray(), db.interpretations.toArray()])
    const interpretationMap = new Map(interpretationRows.map((item) => [item.entryId, item]))
    const failedEntries = entryRows.filter((entry) => entry.processingState === 'error')

    if (failedEntries.length === 0) return 0

    let repairedCount = 0

    await db.transaction('rw', db.entries, db.interpretations, async () => {
      for (const entry of failedEntries) {
        const existingInterpretation = interpretationMap.get(entry.id) ?? null
        const fallbackInterpretation = buildFailedInterpretation(
          {
            id: entry.id,
            content: entry.content,
            createdAt: entry.createdAt,
            preferredType: entry.preferredType ?? null,
          },
          existingInterpretation?.createdAt ?? new Date().toISOString(),
        )

        const nextInterpretation: InterpretationRecord = existingInterpretation
          ? {
              ...existingInterpretation,
              ...fallbackInterpretation,
              createdAt: existingInterpretation.createdAt,
            }
          : fallbackInterpretation

        await db.interpretations.put(nextInterpretation)
        await db.entries.update(entry.id, { processingState: 'classified' })
        repairedCount += 1
      }
    })

    return repairedCount
  }, [])

  const handleTestReminder = useCallback(
    async (item: AppItem) => {
      const result = await triggerReminderTest(item.entry, item.interpretation ?? null)

      if (!result.ok) {
        notifications.show({
          color: 'orange',
          title: '测试提醒失败',
          message: result.reason ?? '当前无法发送测试提醒。',
        })
        return
      }

      if (item.entry.reminderAt) {
        await syncEntryReminder(item.entry.id)
        await loadAll()
      }

      notifications.show({
        color: 'teal',
        title: '测试提醒已发送',
        message: '如果系统通知权限正常，你现在应该会看到一条测试提醒。',
      })
    },
    [loadAll, syncEntryReminder],
  )

  const handleEnableReminderPermission = useCallback(
    async (item: AppItem) => {
      const granted = await requestReminderPermission()

      if (!granted) {
        notifications.show({
          color: 'orange',
          title: '通知权限未开启',
          message: '系统通知权限仍未开启，提醒暂时无法通过桌面弹出。',
        })
        return
      }

      await syncEntryReminder(item.entry.id)
      await loadAll()
      await flushDueRemindersRef.current()
      await triggerReminderTest(item.entry, item.interpretation ?? null)

      notifications.show({
        color: 'teal',
        title: '通知已开启',
        message: '已发送一条测试提醒，之后正式任务会继续走系统通知。',
      })
    },
    [loadAll, syncEntryReminder],
  )

  const flushDueReminders = useCallback(async () => {
    if (reminderPollingRef.current) return
    reminderPollingRef.current = true

    try {
      const dueEntries = await db.entries.where('reminderStatus').equals('scheduled').filter((entry) => isReminderDue(entry)).toArray()
      if (dueEntries.length === 0) return

      const interpretationRows = await db.interpretations.bulkGet(dueEntries.map((entry) => entry.id))
      const interpretationIndex = new Map(
        dueEntries.map((entry, index) => [entry.id, interpretationRows[index] ?? null]),
      )

      let triggeredCount = 0
      let blockedCount = 0

      for (const entry of dueEntries) {
        if (triggeringReminderIdsRef.current.has(entry.id)) continue
        triggeringReminderIdsRef.current.add(entry.id)

        try {
          const reminderState = await triggerEntryReminder(entry, interpretationIndex.get(entry.id) ?? null)
          await db.entries.update(entry.id, reminderState)

          if (reminderState.reminderStatus === 'triggered') triggeredCount += 1
          if (reminderState.reminderStatus === 'permission-denied') blockedCount += 1
        } finally {
          triggeringReminderIdsRef.current.delete(entry.id)
        }
      }

      if (triggeredCount === 0 && blockedCount === 0) return

      await loadAll()

      if (blockedCount > 0) {
        notifications.show({
          color: 'orange',
          title: '有提醒未能弹出',
          message: '系统通知权限未开启，请点击“开启通知”后再试。',
        })
      }

      if (triggeredCount > 0 && blockedCount > 0) {
        setStatusMessage(`已触发 ${triggeredCount} 条提醒，另有 ${blockedCount} 条因通知权限未开启未弹出。`)
      } else if (triggeredCount > 0) {
        setStatusMessage(`已触发 ${triggeredCount} 条提醒。`)
      } else {
        setStatusMessage(`有 ${blockedCount} 条提醒因通知权限未开启未弹出。`)
      }
    } finally {
      reminderPollingRef.current = false
    }
  }, [loadAll])

  flushDueRemindersRef.current = flushDueReminders

  const closeReminderEditor = useCallback(() => {
    setReminderEditorEntryId(null)
    setReminderDraftDate('')
    setReminderDraftTime('')
  }, [])

  const openReminderEditor = useCallback(
    (entry: EntryRecord) => {
      if (reminderEditorEntryId === entry.id) {
        closeReminderEditor()
        return
      }

      const fallback = getDefaultReminderDraft()
      setReminderEditorEntryId(entry.id)
      setReminderDraftDate(toDateInputValue(entry.reminderAt) || fallback.date)
      setReminderDraftTime(toTimeInputValue(entry.reminderAt) || fallback.time)
    },
    [closeReminderEditor, reminderEditorEntryId],
  )

  const saveManualReminder = useCallback(
    async (item: AppItem) => {
      const reminderAt = buildReminderAt(reminderDraftDate, reminderDraftTime)
      if (!reminderAt) {
        notifications.show({
          color: 'orange',
          title: '提醒时间不完整',
          message: '请先选择日期和时间，再保存提醒。',
        })
        return
      }

      if (new Date(reminderAt).getTime() <= Date.now()) {
        notifications.show({
          color: 'orange',
          title: '提醒时间已过',
          message: '提醒必须晚于当前时间，请重新选择。',
        })
        return
      }

      setReminderSavingEntryId(item.entry.id)

      try {
        await db.entries.update(item.entry.id, {
          reminderAt,
          reminderNotificationId: null,
          reminderScheduledAt: null,
          reminderTriggeredAt: null,
          reminderStatus: 'idle',
          reminderReason: null,
        })

        const reminderState = await syncEntryReminder(item.entry.id)
        await loadAll()
        closeReminderEditor()
        setStatusMessage('提醒时间已更新。')

        if (reminderState?.reminderStatus === 'permission-denied') {
          notifications.show({
            color: 'orange',
            title: '提醒已保存，等待通知权限',
            message: reminderState.reminderReason ?? '开启系统通知后，这条提醒就可以正常弹出。',
          })
          return
        }

        notifications.show({
          color: 'teal',
          title: '提醒已保存',
          message: `将在 ${timeLabel(reminderAt)} 提醒你。`,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('save manual reminder failed', error)
        notifications.show({
          color: 'red',
          title: '提醒保存失败',
          message: message && message !== '[object Object]' ? `本地提醒没有更新成功：${message}` : '本地提醒没有更新成功，请再试一次。',
        })
      } finally {
        setReminderSavingEntryId((current) => (current === item.entry.id ? null : current))
      }
    },
    [closeReminderEditor, loadAll, reminderDraftDate, reminderDraftTime, syncEntryReminder],
  )

  const clearManualReminder = useCallback(
    async (item: AppItem) => {
      setReminderSavingEntryId(item.entry.id)

      try {
        await db.entries.update(item.entry.id, {
          reminderAt: null,
          reminderNotificationId: null,
          reminderScheduledAt: null,
          reminderTriggeredAt: null,
          reminderStatus: 'idle',
          reminderReason: null,
        })

        await syncEntryReminder(item.entry.id)
        await loadAll()
        closeReminderEditor()
        setStatusMessage('提醒已关闭。')
        notifications.show({
          color: 'gray',
          title: '提醒已关闭',
          message: '这条内容后续不会再触发桌面提醒。',
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('clear manual reminder failed', error)
        notifications.show({
          color: 'red',
          title: '关闭提醒失败',
          message: message && message !== '[object Object]' ? `暂时没能关闭这条提醒：${message}` : '暂时没能关闭这条提醒，请再试一次。',
        })
      } finally {
        setReminderSavingEntryId((current) => (current === item.entry.id ? null : current))
      }
    },
    [closeReminderEditor, loadAll, syncEntryReminder],
  )

  const reconcileDuplicateTopics = useCallback(async () => {
    if (reconciledTopicsRef.current) return
    reconciledTopicsRef.current = true

    const topicRows = sortByCreatedAtAsc(await db.topics.toArray())
    const planTopics = topicRows.filter((topic) => topic.kind === 'plan')
    const grouped = new Map<string, TopicRecord[]>()

    for (const topic of planTopics) {
      const mergeKey = buildTopicMergeKey(topic.name, topic.kind)
      const current = grouped.get(mergeKey) ?? []
      current.push(topic)
      grouped.set(mergeKey, current)
    }

    const duplicateGroups = [...grouped.values()].filter((topicsGroup) => topicsGroup.length > 1)
    if (duplicateGroups.length === 0) return

    for (const topicsGroup of duplicateGroups) {
      const [primary, ...duplicates] = topicsGroup
      const canonicalName = canonicalizeTopicName(primary.name, primary.kind)

      for (const duplicate of duplicates) {
        await db.interpretations
          .where('topicId')
          .equals(duplicate.id)
          .modify((record) => {
            record.topicId = primary.id
            record.topicName = canonicalName
            record.topicKind = primary.kind
          })

        await db.topics.delete(duplicate.id)
      }

      await db.topics.update(primary.id, {
        name: canonicalName,
        updatedAt: new Date().toISOString(),
        summaryState: 'queued',
      })

      await queueTopicRefresh(primary.id)
    }

    await loadAll()
    setStatusMessage(`已自动合并 ${duplicateGroups.length} 组相近主题。`)
  }, [loadAll, queueTopicRefresh])

  const refreshTopicSummary = useCallback(
    async (topicId: string) => {
      const topic = await db.topics.get(topicId)
      if (!topic) return

      await db.topics.update(topicId, { summaryState: 'updating' })
      await loadAll()

      try {
        const interpretationRows = await db.interpretations.where('topicId').equals(topicId).toArray()
        const entryIds = interpretationRows.map((item) => item.entryId)
        const entryRows = await db.entries.bulkGet(entryIds)
        const entryIndex = new Map(entryRows.filter(Boolean).map((entry) => [entry!.id, entry!]))

        const summaryInputs: TopicSummaryInput[] = sortByCreatedAtAsc(
          interpretationRows
            .map((interpretation) => {
              const entry = entryIndex.get(interpretation.entryId)
              if (!entry) return null
              return {
                content: entry.content,
                displayTitle: interpretation.needsReview ? entry.content : interpretation.displayTitle,
                createdAt: entry.createdAt,
                type: interpretation.type,
                completed: isCompletedEntry(entry),
              }
            })
            .filter(Boolean) as TopicSummaryInput[],
        )

        const summary = await summarizeTopic(topic.name, topic.kind, topic.summary, summaryInputs)
        await db.topics.update(topicId, {
          summary,
          updatedAt: new Date().toISOString(),
          summaryState: 'idle',
        })
      } catch {
        await db.topics.update(topicId, {
          summaryState: 'error',
          updatedAt: new Date().toISOString(),
        })
      } finally {
        await loadAll()
      }
    },
    [loadAll],
  )

  const processJob = useCallback(
    async (job: QueueJob) => {
      const queuedBehind = Math.max(0, queue.length - 1)
      setStatusMessage(`正在并行整理，运行中 ${activeJobs.length || 1} 条，排队 ${queuedBehind} 条。`)

      try {
        const initialEntry = await db.entries.get(job.entryId)
        if (!initialEntry) return

        await db.entries.update(job.entryId, { processingState: 'processing' })
        await loadAll()

        const topicRows = await db.topics.toArray()
        const candidates: TopicCandidate[] = topicRows.map((topic) => ({
          id: topic.id,
          name: topic.name,
          kind: topic.kind,
          summary: topic.summary,
        }))

        const result = await classifyEntry(job.content, candidates, job.preferredType)
        const entryAfterClassification = await db.entries.get(job.entryId)
        if (!entryAfterClassification) return
        let resolvedTopicId: string | null = null
        let reminderFailureMessage: string | null = null

        await runInFinalizeQueue(async () => {
          const currentEntry = await db.entries.get(job.entryId)
          if (!currentEntry) return

          const latestTopics = await db.topics.toArray()
          const topicIndex = new Map(latestTopics.map((topic) => [topic.id, topic]))
          let topic: TopicRecord | null = null
          const expectedPlanTopic = result.type === 'task'
          const reminderMatch = expectedPlanTopic ? inferReminderFromText(job.content, new Date(job.createdAt)) : null
          if (reminderMatch && reminderMatch.status !== 'none' && reminderMatch.status !== 'scheduled') {
            reminderFailureMessage = reminderMatch.reason
          }

          if (result.topicId && topicIndex.has(result.topicId)) {
            const candidateTopic = topicIndex.get(result.topicId) ?? null
            if (
              candidateTopic &&
              ((expectedPlanTopic && isPlanTopicKind(candidateTopic.kind)) ||
                (!expectedPlanTopic && isNoteTopicKind(candidateTopic.kind)))
            ) {
              topic = candidateTopic
            }
          } else if (result.shouldCreateTopic && result.topicName) {
            const targetKind = expectedPlanTopic ? 'plan' : result.topicKind ?? 'mixed'
            const canonicalTopicName = canonicalizeTopicName(result.topicName, targetKind)
            const targetMergeKey = buildTopicMergeKey(canonicalTopicName, targetKind)
            const existingTopic =
              latestTopics.find(
                (item) => item.kind === targetKind && buildTopicMergeKey(item.name, item.kind) === targetMergeKey,
              ) ?? null

            topic =
              existingTopic ??
              ({
                id: generateId(),
                name: canonicalTopicName,
                kind: targetKind,
                summary: result.topicSummary ?? '',
                createdAt: job.createdAt,
                updatedAt: job.createdAt,
                summaryState: 'queued',
              } satisfies TopicRecord)

            await db.topics.put({
              ...topic,
              summary: topic.summary || result.topicSummary || '',
              updatedAt: new Date().toISOString(),
              summaryState: 'queued',
            })
          }

          resolvedTopicId = topic?.id ?? null

          const interpretation: InterpretationRecord = {
            entryId: job.entryId,
            type: result.type,
            displayTitle: result.displayTitle,
            rationale: result.rationale,
            confidence: result.confidence,
            topicId: topic?.id ?? null,
            topicName:
              topic?.name ??
              (result.topicName && result.topicKind ? canonicalizeTopicName(result.topicName, result.topicKind) : result.topicName) ??
              null,
            topicKind: topic?.kind ?? result.topicKind ?? null,
            topicSummary: result.topicSummary,
            needsReview: result.needsReview,
            usedAi: hasAiConfig(),
            model: hasAiConfig() ? aiSettings.model : null,
            createdAt: new Date().toISOString(),
            typeSource: job.preferredType ? 'manual' : 'auto',
          }

          await db.interpretations.put(interpretation)
          await db.entries.update(job.entryId, {
            processingState: 'classified',
            reminderAt: reminderMatch?.status === 'scheduled' ? reminderMatch.reminderAt : null,
            reminderNotificationId: null,
            reminderScheduledAt: null,
            reminderTriggeredAt: null,
            reminderStatus: reminderMatch?.status === 'none' ? 'idle' : reminderMatch?.status ?? 'idle',
            reminderReason: reminderMatch?.reason ?? null,
          })
        })

        const reminderState = await syncEntryReminder(job.entryId)

        if (reminderState?.reminderStatus === 'permission-denied') {
          notifications.show({
            color: 'orange',
            title: '提醒未开启',
            message: reminderState.reminderReason ?? '请先允许 AI Inbox 发送系统通知。',
          })
        } else if (reminderFailureMessage) {
          notifications.show({
            color: 'orange',
            title: '未创建提醒',
            message: reminderFailureMessage,
          })
        }

        if (resolvedTopicId) {
          await queueTopicRefresh(resolvedTopicId)
        }

        await loadAll()
        setStatusMessage(
          result.needsReview ? '已整理 1 条内容，分类已完成，主题摘要会在后台继续更新。' : '已整理 1 条内容。',
        )
      } catch (error) {
        const existingEntry = await db.entries.get(job.entryId)
        if (!existingEntry) return

        await db.entries.update(job.entryId, { processingState: 'error' })
        const fallbackInterpretation = buildFailedInterpretation({
          id: job.entryId,
          content: job.content,
          createdAt: job.createdAt,
          preferredType: job.preferredType,
        })
        await db.interpretations.put(fallbackInterpretation)
        await db.entries.update(job.entryId, { processingState: 'classified' })
        await loadAll()
        const message = buildAiErrorMessage(error)
        const fallbackLabel = fallbackInterpretation.type === 'task' ? '计划' : '笔记'
        if (fallbackInterpretation) {
          setStatusMessage(
            job.preferredType
              ? `AI 整理失败，已按${fallbackLabel}加入对应分类。`
              : 'AI 整理失败，已按默认规则加入笔记。',
          )
          notifications.show({
            color: 'orange',
            title: 'AI 整理失败，已兜底保存',
            message: job.preferredType
              ? `${message}。已按${fallbackLabel}保存，原始内容仍在本地。`
              : `${message}。已按默认规则保存到笔记，原始内容仍在本地。`,
          })
        } else {
/*
        setStatusMessage(`AI 调用失败：${message}。原始内容已经保存在本地。`)
        notifications.show({ color: 'red', title: 'AI 整理失败', message })
*/
        }
      } finally {
        runningJobIdsRef.current.delete(job.entryId)
        setActiveJobs((current) => current.filter((item) => item.entryId !== job.entryId))
      }
    },
    [activeJobs.length, loadAll, queue.length, queueTopicRefresh, runInFinalizeQueue, syncEntryReminder],
  )

  useEffect(() => {
    async function initialize() {
      const repairedCount = await recoverFailedEntries()
      await loadAll()
      const [entryRows, , topicRows] = await Promise.all([
        db.entries.toArray(),
        db.interpretations.toArray(),
        db.topics.toArray(),
      ])
      const pendingJobs = sortByCreatedAtAsc(
        entryRows.filter(
          (entry) =>
            entry.processingState === 'pending' || entry.processingState === 'processing',
        ),
      ).map((entry) => ({
        entryId: entry.id,
        content: entry.content,
        createdAt: entry.createdAt,
        preferredType: entry.preferredType ?? null,
      }))

      setQueue((current) => {
        const existingIds = new Set(current.map((item) => item.entryId))
        const merged = [...current]
        for (const job of pendingJobs) {
          if (!existingIds.has(job.entryId)) merged.push(job)
        }
        return merged
      })

      const topicIdsToRefresh = topicRows
        .filter((topic) => topic.summaryState === 'queued' || topic.summaryState === 'updating')
        .map((topic) => topic.id)

      if (topicIdsToRefresh.length > 0) {
        for (const topicId of topicIdsToRefresh) {
          pendingTopicRefreshesRef.current.add(topicId)
        }
        setSummaryQueueVersion((value) => value + topicIdsToRefresh.length)
      }

      if (repairedCount > 0) {
        setStatusMessage(`已恢复 ${repairedCount} 条 AI 失败的内容到计划或笔记。`)
      }
    }

    void initialize()
  }, [loadAll, recoverFailedEntries])

  useEffect(() => {
    return subscribeAiSettings(() => {
      setAiSettingsRevision((value) => value + 1)
    })
  }, [])

  useEffect(() => {
    void reconcileDuplicateTopics()
  }, [reconcileDuplicateTopics])

  useEffect(() => {
    async function syncExistingReminders() {
      const reminderEntries = await db.entries
        .filter((entry) => Boolean(entry.reminderAt))
        .toArray()

      for (const entry of reminderEntries) {
        await syncEntryReminder(entry.id)
      }
    }

    void syncExistingReminders()
  }, [syncEntryReminder])

  useEffect(() => {
    void flushDueReminders()

    const intervalId = window.setInterval(() => {
      void flushDueReminders()
    }, 5000)

    const handleFocus = () => {
      void flushDueReminders()
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void flushDueReminders()
      }
    }

    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.clearInterval(intervalId)
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [flushDueReminders])

  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    if (queue.length === 0 || activeJobs.length >= MAX_CONCURRENT_JOBS) return

    const slots = MAX_CONCURRENT_JOBS - activeJobs.length
    const jobsToStart = queue.slice(0, slots)
    if (jobsToStart.length === 0) return

    setQueue((current) => current.slice(jobsToStart.length))
    setActiveJobs((current) => [...current, ...jobsToStart])
  }, [activeJobs.length, queue])

  useEffect(() => {
    const freshJobs = activeJobs.filter((job) => !runningJobIdsRef.current.has(job.entryId))
    if (freshJobs.length === 0) return

    for (const job of freshJobs) {
      runningJobIdsRef.current.add(job.entryId)
      void processJob(job)
    }
  }, [activeJobs, processJob])

  useEffect(() => {
    const queuedTopicIds = [...pendingTopicRefreshesRef.current].filter(
      (topicId) => !activeTopicRefreshesRef.current.has(topicId),
    )
    if (queuedTopicIds.length === 0) return

    for (const topicId of queuedTopicIds) {
      pendingTopicRefreshesRef.current.delete(topicId)
      activeTopicRefreshesRef.current.add(topicId)

      void refreshTopicSummary(topicId).finally(() => {
        activeTopicRefreshesRef.current.delete(topicId)
        if (pendingTopicRefreshesRef.current.has(topicId)) {
          setSummaryQueueVersion((value) => value + 1)
        }
      })
    }
  }, [refreshTopicSummary, summaryQueueVersion])

  const interpretationMap = useMemo(() => new Map(interpretations.map((item) => [item.entryId, item])), [interpretations])

  const appItems = useMemo<AppItem[]>(
    () => entries.map((entry) => ({ entry, interpretation: interpretationMap.get(entry.id) ?? null })),
    [entries, interpretationMap],
  )

  const groupedTopics = useMemo<TopicBundle[]>(() => {
    const buckets = new Map<string, TopicBundle>()
    for (const topic of topics) buckets.set(topic.id, { topic, items: [] })
    for (const item of appItems) {
      const topicId = item.interpretation?.topicId
      if (!topicId) continue
      const bucket = buckets.get(topicId)
      if (bucket) bucket.items.push(item)
    }
    return sortTopicBundlesByUpdatedAtDesc([...buckets.values()].filter((bucket) => bucket.items.length > 0))
  }, [appItems, topics])

  const looseItems = useMemo(() => appItems.filter((item) => !item.interpretation?.topicId), [appItems])

  const visibleTopics = useMemo(
    () =>
      sortTopicBundlesForView(
        groupedTopics.filter(({ topic, items }) => {
          if (activeView === 'plan') {
            return isPlanTopicKind(topic.kind) && items.some((item) => item.interpretation?.type === 'task')
          }
          return isNoteTopicKind(topic.kind) && items.some((item) => item.interpretation?.type !== 'task')
        }),
        activeView,
      ),
    [activeView, groupedTopics],
  )

  const visibleLooseItems = useMemo(
    () =>
      looseItems.filter((item) => {
        const type = item.interpretation?.type ?? null
        return sectionMatches(null, type, activeView)
      }),
    [activeView, looseItems],
  )

  const metrics = useMemo(
    () => ({
      plans: appItems.filter((item) => item.interpretation?.type === 'task').length,
      notes: appItems.filter((item) => item.interpretation?.type !== 'task').length,
    }),
    [appItems],
  )

  const pendingCount = queue.length + activeJobs.length
  const summaryUpdatingCount = topics.filter((topic) => topic.summaryState === 'queued' || topic.summaryState === 'updating').length
  const routeLabel = hasAiConfig() ? aiSettings.model : '本地兜底规则'
  const routeHint = hasAiConfig()
    ? aiSettings.baseUrl
    : '在 .env.local 里配置 VITE_AI_* 后，就会切到模型整理。'
  const layoutMode = getLayoutMode(viewportWidth)
  const isCompactLayout = layoutMode !== 'full'
  const isMinimalLayout = layoutMode === 'minimal'
  const containerSize = layoutMode === 'full' ? 1320 : layoutMode === 'compact' ? 1040 : 760
  const drawerSize = layoutMode === 'full' ? 640 : layoutMode === 'compact' ? 520 : '100%'
  const heroTitle =
    layoutMode === 'full'
      ? '把一句话扔进来，剩下的交给 AI。'
      : layoutMode === 'compact'
        ? '输入一句，后台会继续整理。'
        : '输入一条内容'
  const helperText =
    layoutMode === 'full'
      ? '回车发送，Shift + Enter 换行。选择计划或笔记后会先进入对应分类，再由 AI 在后台整理主题。'
      : layoutMode === 'compact'
        ? '回车发送，AI 会在后台继续整理。'
        : null
  const statusTitle = pendingCount > 0 ? `并发处理中 ${pendingCount}` : '后台空闲'
  const statusDetail =
    summaryUpdatingCount > 0 ? `${statusMessage} 主题摘要待更新 ${summaryUpdatingCount} 个。` : statusMessage

  const topMetrics = [
    { key: 'plans', label: '计划', value: metrics.plans, icon: <IconChecklist size={15} />, view: 'plan' as const, color: 'cyan' },
    { key: 'notes', label: '笔记', value: metrics.notes, icon: <IconNotes size={15} />, view: 'note' as const, color: 'orange' },
  ] as const

  const openInbox = useCallback((view: ActiveView = 'plan') => {
    setActiveView(view)
    setInboxOpened(true)
  }, [])

  const togglePlanComplete = useCallback(
    async (item: AppItem) => {
      const nextCompletedAt = isCompletedEntry(item.entry) ? null : new Date().toISOString()
      await db.entries.update(item.entry.id, { completedAt: nextCompletedAt })
      await syncEntryReminder(item.entry.id)
      await loadAll()
      setStatusMessage(nextCompletedAt ? '计划已直接标记完成，无需等待 AI。' : '计划已恢复为进行中。')
    },
    [loadAll, syncEntryReminder],
  )

  const deleteItem = useCallback(
    async (item: AppItem) => {
      const label = item.interpretation ? (item.interpretation.type === 'task' ? '这条计划' : '这条笔记') : '这条内容'
      if (!window.confirm(`确认删除${label}吗？删除后无法恢复。`)) {
        return
      }

      const topicId = item.interpretation?.topicId ?? null

      setQueue((current) => current.filter((job) => job.entryId !== item.entry.id))
      setActiveJobs((current) => current.filter((job) => job.entryId !== item.entry.id))
      runningJobIdsRef.current.delete(item.entry.id)
      setExpandedSourceIds((current) => current.filter((id) => id !== item.entry.id))
      if (reminderEditorEntryId === item.entry.id) {
        closeReminderEditor()
      }

      await db.transaction('rw', db.entries, db.interpretations, db.topics, async () => {
        await db.entries.delete(item.entry.id)
        await db.interpretations.delete(item.entry.id)

        if (topicId) {
          const remaining = await db.interpretations.where('topicId').equals(topicId).count()
          if (remaining === 0) {
            await db.topics.delete(topicId)
            pendingTopicRefreshesRef.current.delete(topicId)
            activeTopicRefreshesRef.current.delete(topicId)
          }
        }
      })

      await loadAll()
      setStatusMessage('已删除 1 条内容。')
      notifications.show({
        color: 'gray',
        title: '内容已删除',
        message: `${label}已从本地移除。`,
      })
    },
    [closeReminderEditor, loadAll, reminderEditorEntryId],
  )

  const openAiSettings = useCallback(() => {
    setAiSettingsDraft(cloneAiSettingsDraft(getAiSettings()))
    setAiSettingsOpened(true)
  }, [])

  const closeAiSettings = useCallback(() => {
    setAiSettingsOpened(false)
  }, [])

  const saveAiSettingsDraft = useCallback(() => {
    const savedSettings = saveAiSettings(aiSettingsDraft)
    setAiSettingsDraft(cloneAiSettingsDraft(savedSettings))
    setAiSettingsRevision((value) => value + 1)
    setAiSettingsOpened(false)
    notifications.show({
      color: 'teal',
      title: '模型配置已保存',
      message: '新的 Base URL、API Key 和 Model 会立即用于后续整理请求。',
    })
  }, [aiSettingsDraft])

  const restoreDefaultAiSettings = useCallback(() => {
    const restoredSettings = resetAiSettings()
    const defaultSettings = getDefaultAiSettings()
    setAiSettingsDraft(cloneAiSettingsDraft(restoredSettings))
    setAiSettingsRevision((value) => value + 1)
    notifications.show({
      color: 'gray',
      title: '已恢复默认配置',
      message: defaultSettings.baseUrl ? '已切回应用默认的模型配置。' : '已清空本地覆盖配置。',
    })
  }, [])

  const toggleSourceExpanded = useCallback((entryId: string) => {
    setExpandedSourceIds((current) =>
      current.includes(entryId) ? current.filter((id) => id !== entryId) : [...current, entryId],
    )
  }, [])

  const toggleTheme = useCallback(() => {
    setColorScheme(computedColorScheme === 'dark' ? 'light' : 'dark')
  }, [computedColorScheme, setColorScheme])

  const renderCompletedPlanEntry = useCallback(
    (item: AppItem) => {
      const { entry, interpretation } = item
      return (
        <Paper key={entry.id} className={`${getEntrySurfaceClass('task', true)} completed-entry-row`} radius={14} p="sm">
          <div className="completed-entry-layout">
            <Group gap="sm" wrap="nowrap" className="completed-row-main">
              <ThemeIcon radius="xl" size={24} color="teal" variant="light" className="completed-check-icon">
                <IconCheck size={15} stroke={2.6} />
              </ThemeIcon>
              <Text className="completed-title" lineClamp={1} title={interpretation?.displayTitle ?? entry.content}>
                {interpretation?.displayTitle ?? entry.content}
              </Text>
            </Group>
            <Group gap="xs" wrap="nowrap" className="completed-actions">
              <Text size="sm" c="dimmed" className="completed-time">
                {timeLabel(entry.completedAt ?? entry.createdAt)}
              </Text>
              <Button
                size="xs"
                radius="xl"
                variant="subtle"
                color="gray"
                className="plan-restore-button"
                leftSection={<IconRotateClockwise2 size={14} />}
                onClick={() => void togglePlanComplete(item)}
              >
                恢复
              </Button>
              <Button
                size="xs"
                radius="xl"
                variant="subtle"
                color="red"
                className="entry-delete-button"
                leftSection={<IconTrash size={13} />}
                onClick={() => void deleteItem(item)}
              >
                删除
              </Button>
            </Group>
          </div>
        </Paper>
      )
    },
    [deleteItem, togglePlanComplete],
  )

  const renderReminderControl = useCallback(
    (item: AppItem) => {
      const { entry } = item
      const reminderMeta = getReminderMeta(entry)
      const opened = reminderEditorEntryId === entry.id
      const saving = reminderSavingEntryId === entry.id
      const hasReminderState = Boolean(entry.reminderAt) || Boolean(entry.reminderStatus && entry.reminderStatus !== 'idle')
      const triggerLabel = reminderMeta?.label ?? '提醒'
      const triggerTitle =
        entry.reminderReason ??
        (entry.reminderAt ? `提醒 ${timeLabel(entry.reminderAt)}` : '点击设置提醒时间')

      return (
        <Popover
          opened={opened}
          onChange={(nextOpened) => {
            if (!nextOpened) closeReminderEditor()
          }}
          position="bottom-start"
          width={292}
          radius={20}
          shadow="md"
          withArrow
        >
          <Popover.Target>
            <button
              type="button"
              className={`reminder-trigger ${reminderMeta ? 'reminder-trigger-active' : 'reminder-trigger-idle'}`}
              title={triggerTitle}
              onClick={() => openReminderEditor(entry)}
            >
              <IconBellRinging size={12} />
              <span>{triggerLabel}</span>
            </button>
          </Popover.Target>

          <Popover.Dropdown className="reminder-editor-popover">
            <Stack gap="sm">
              <div>
                <Text className="reminder-editor-title">提醒时间</Text>
                <Text size="xs" c="dimmed" mt={4}>
                  保存后会直接更新这条内容的桌面提醒。
                </Text>
              </div>

              {entry.reminderReason ? (
                <Text size="xs" c="dimmed" className="reminder-editor-reason">
                  {entry.reminderReason}
                </Text>
              ) : null}

              <div className="reminder-editor-grid">
                <label className="reminder-editor-field">
                  <span>日期</span>
                  <input
                    type="date"
                    value={reminderDraftDate}
                    onChange={(event) => setReminderDraftDate(event.currentTarget.value)}
                  />
                </label>

                <label className="reminder-editor-field">
                  <span>时间</span>
                  <input
                    type="time"
                    step={300}
                    value={reminderDraftTime}
                    onChange={(event) => setReminderDraftTime(event.currentTarget.value)}
                  />
                </label>
              </div>

              <Group justify="space-between" wrap="nowrap" gap="xs">
                <Button size="xs" radius="xl" variant="subtle" color="gray" disabled={saving} onClick={closeReminderEditor}>
                  取消
                </Button>

                <Group gap="xs" wrap="nowrap">
                  {hasReminderState ? (
                    <Button
                      size="xs"
                      radius="xl"
                      variant="subtle"
                      color="gray"
                      disabled={saving}
                      onClick={() => void clearManualReminder(item)}
                    >
                      关闭提醒
                    </Button>
                  ) : null}
                  <Button
                    size="xs"
                    radius="xl"
                    color="violet"
                    loading={saving}
                    onClick={() => void saveManualReminder(item)}
                  >
                    保存提醒
                  </Button>
                </Group>
              </Group>
            </Stack>
          </Popover.Dropdown>
        </Popover>
      )
    },
    [
      clearManualReminder,
      closeReminderEditor,
      openReminderEditor,
      reminderDraftDate,
      reminderDraftTime,
      reminderEditorEntryId,
      reminderSavingEntryId,
      saveManualReminder,
    ],
  )

  const renderPlanEntry = useCallback(
    (item: AppItem) => {
      const { entry, interpretation } = item
      const showSourceToggle = hasDisplayRewrite(interpretation?.displayTitle, entry.content)
      const sourceExpanded = expandedSourceIds.includes(entry.id)
      const canTestReminder = entry.reminderStatus === 'scheduled'
      const canEnableReminderPermission = entry.reminderStatus === 'permission-denied'

      return (
        <Paper key={entry.id} className={`${getEntrySurfaceClass('task')} entry-surface-plan-compact`} radius={16} p="sm">
          <div className="plan-entry-main">
            <Text className="entry-title plan-entry-title" fw={700} lineClamp={1} title={interpretation?.displayTitle ?? entry.content}>
              {interpretation?.displayTitle ?? entry.content}
            </Text>

            <div className="plan-entry-footer">
              <Group gap="xs" wrap="nowrap" className="plan-entry-meta">
                <Text size="sm" c="dimmed" className="plan-entry-time">
                  {timeLabel(entry.createdAt)}
                </Text>
                {renderReminderControl(item)}
                {interpretation?.needsReview ? (
                  <Badge variant="filled" color="orange" className="plan-inline-badge">
                    复核
                  </Badge>
                ) : null}
              </Group>

              <Group gap="xs" wrap="nowrap" className="plan-entry-actions">
                {canEnableReminderPermission ? (
                  <Button
                    variant="subtle"
                    size="xs"
                    radius="xl"
                    color="orange"
                    className="enable-reminder-button"
                    leftSection={<IconBellRinging size={13} />}
                    onClick={() => void handleEnableReminderPermission(item)}
                  >
                    开启通知
                  </Button>
                ) : null}
                {canTestReminder ? (
                  <Button
                    variant="subtle"
                    size="xs"
                    radius="xl"
                    color="violet"
                    className="test-reminder-button"
                    leftSection={<IconBellRinging size={13} />}
                    onClick={() => void handleTestReminder(item)}
                  >
                    测试提醒
                  </Button>
                ) : null}
                {showSourceToggle ? (
                  <Button
                    variant="subtle"
                    size="xs"
                    radius="xl"
                    color="gray"
                    className="source-toggle-button source-toggle-button-compact"
                    rightSection={sourceExpanded ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
                    onClick={() => toggleSourceExpanded(entry.id)}
                  >
                    原文
                  </Button>
                ) : null}
                <Button
                  size="xs"
                  radius="xl"
                  variant="filled"
                  className="plan-complete-button plan-complete-button-compact"
                  leftSection={<IconCheck size={14} stroke={2.6} />}
                  onClick={() => void togglePlanComplete(item)}
                >
                  完成
                </Button>
                <Button
                  size="xs"
                  radius="xl"
                  variant="subtle"
                  color="red"
                  className="entry-delete-button"
                  leftSection={<IconTrash size={13} />}
                  onClick={() => void deleteItem(item)}
                >
                  删除
                </Button>
              </Group>
            </div>
          </div>

          {showSourceToggle ? (
            <Collapse in={sourceExpanded}>
              <Paper className="source-panel plan-source-panel" radius={16} p="sm" mt="sm">
                <Text className="source-label">原文</Text>
                <Text mt={6}>{entry.content}</Text>
              </Paper>
            </Collapse>
          ) : null}
        </Paper>
      )
    },
    [
      expandedSourceIds,
      handleEnableReminderPermission,
      handleTestReminder,
      deleteItem,
      renderReminderControl,
      togglePlanComplete,
      toggleSourceExpanded,
    ],
  )

  const renderNoteEntry = useCallback(
    (item: AppItem) => {
      const { entry, interpretation } = item
      const showSourceToggle = hasDisplayRewrite(interpretation?.displayTitle, entry.content)
      const sourceExpanded = expandedSourceIds.includes(entry.id)
      const canTestReminder = entry.reminderStatus === 'scheduled'
      const canEnableReminderPermission = entry.reminderStatus === 'permission-denied'

      return (
        <Paper key={entry.id} className={getEntrySurfaceClass(interpretation?.type ?? null)} radius={22} p="md">
          <Group justify="space-between" align="flex-start" mb={10} wrap="wrap" className="entry-head">
            <Group gap="xs" wrap="wrap">
              <Badge variant="dot" color={interpretation ? getTypeColor(interpretation.type) : 'gray'}>
                {interpretation ? typeLabels[interpretation.type] : processingLabels[entry.processingState]}
              </Badge>
              <Text size="sm" c="dimmed">
                {timeLabel(entry.createdAt)}
              </Text>
            </Group>
          </Group>

          <Title order={4} className="entry-title">
            {interpretation?.displayTitle ?? entry.content}
          </Title>

          {showSourceToggle ? (
            <>
              <Button
                variant="subtle"
                size="xs"
                radius="xl"
                color="gray"
                className="source-toggle-button"
                mt="sm"
                rightSection={sourceExpanded ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
                onClick={() => toggleSourceExpanded(entry.id)}
              >
                {sourceExpanded ? '收起原文' : '查看原文'}
              </Button>
              <Collapse in={sourceExpanded}>
                <Paper className="source-panel" radius={18} p="sm" mt="sm">
                  <Text className="source-label">原文</Text>
                  <Text mt={6}>{entry.content}</Text>
                </Paper>
              </Collapse>
            </>
          ) : null}

          {interpretation ? (
            <>
              <div className="note-entry-footer">
                <Group gap="xs" wrap="wrap" className="note-entry-meta">
                  {renderReminderControl(item)}
                  <Badge variant="light" color={getTypeColor(interpretation.type)}>
                    置信度 {Math.round(interpretation.confidence * 100)}%
                  </Badge>
                  {interpretation.needsReview ? (
                    <Badge variant="filled" color="orange">
                      建议复核
                    </Badge>
                  ) : null}
                </Group>

                <Group gap="xs" wrap="wrap" className="note-entry-actions">
                  {canEnableReminderPermission ? (
                    <Button
                      variant="subtle"
                      size="xs"
                      radius="xl"
                      color="orange"
                      className="enable-reminder-button"
                      leftSection={<IconBellRinging size={13} />}
                      onClick={() => void handleEnableReminderPermission(item)}
                    >
                      开启通知
                    </Button>
                  ) : null}
                  {canTestReminder ? (
                    <Button
                      variant="subtle"
                      size="xs"
                      radius="xl"
                      color="violet"
                      className="test-reminder-button"
                      leftSection={<IconBellRinging size={13} />}
                      onClick={() => void handleTestReminder(item)}
                    >
                      测试提醒
                    </Button>
                  ) : null}
                  <Button
                    variant="subtle"
                    size="xs"
                    radius="xl"
                    color="red"
                    className="entry-delete-button"
                    leftSection={<IconTrash size={13} />}
                    onClick={() => void deleteItem(item)}
                  >
                    删除
                  </Button>
                </Group>
              </div>

              <Text size="sm" c="dimmed" mt="sm" className="note-entry-rationale">
                {interpretation.rationale}
              </Text>
            </>
          ) : null}
        </Paper>
      )
    },
    [
      expandedSourceIds,
      handleEnableReminderPermission,
      handleTestReminder,
      deleteItem,
      renderReminderControl,
      toggleSourceExpanded,
    ],
  )

  const handleSubmit = useCallback(async () => {
    const content = draft.trim()
    if (!content) return

    const now = new Date().toISOString()
    const entryId = generateId()
    const preferredType = composerType === 'auto' ? null : composerType
    const entry: EntryRecord = {
      id: entryId,
      content,
      createdAt: now,
      source: 'manual',
      processingState: 'pending',
      preferredType,
      reminderAt: null,
      reminderNotificationId: null,
      reminderScheduledAt: null,
      reminderTriggeredAt: null,
      reminderStatus: 'idle',
      reminderReason: null,
    }

    setDraft('')
    await db.entries.add(entry)

    if (preferredType) {
      const preferredTopicKind: TopicKind | null = preferredType === 'task' ? 'plan' : null

      const provisionalInterpretation: InterpretationRecord = {
        entryId,
        type: preferredType,
        displayTitle: content,
        rationale: '用户手动指定了类型，AI 正在后台整理主题和表述。',
        confidence: 1,
        topicId: null,
        topicName: null,
        topicKind: preferredTopicKind,
        topicSummary: null,
        needsReview: false,
        usedAi: false,
        model: null,
        createdAt: now,
        typeSource: 'manual',
      }

      await db.interpretations.put(provisionalInterpretation)
    }

    await loadAll()
    setQueue((current) => [...current, { entryId, content, createdAt: now, preferredType }])
    setStatusMessage(
      preferredType
        ? `已按${composerTypeLabels[preferredType]}加入对应分类，AI 正在后台继续整理。`
        : `已加入并发队列。当前有 ${pendingCount + 1} 条内容等待处理。`,
    )
  }, [composerType, draft, loadAll, pendingCount])

  return (
    <div className={`page-shell page-shell-${layoutMode}`}>
      <div className="page-glow page-glow-left" />
      <div className="page-glow page-glow-right" />

      <Container size={containerSize} className="app-frame">
        <div className={`app-layout app-layout-${layoutMode}`}>
          <MotionDiv
            className={`overview-strip overview-strip-${layoutMode}`}
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.42 }}
          >
            {!isMinimalLayout ? (
              <div className="metric-strip">
                {topMetrics.map((metric) => (
                  <button
                    key={metric.key}
                    type="button"
                    className="metric-card"
                    onClick={() => openInbox(metric.view)}
                  >
                    <ThemeIcon radius="xl" size={isCompactLayout ? 30 : 34} variant="light" color={metric.color}>
                      {metric.icon}
                    </ThemeIcon>
                    <div className="metric-copy">
                      <Text size="sm" c="dimmed">
                        {metric.label}
                      </Text>
                      <Text className="metric-value">{metric.value}</Text>
                    </div>
                  </button>
                ))}
              </div>
            ) : null}

            <div className={`control-strip control-strip-${layoutMode}`}>
              <HoverCard width={320} shadow="md" radius={22} position="bottom-end" withArrow openDelay={60}>
                <HoverCard.Target>
                  <Paper className="engine-pill" radius="xl" p={isMinimalLayout ? 4 : 'xs'}>
                    <Indicator inline size={10} color={hasAiConfig() ? 'teal' : 'gray'} offset={6}>
                      <ThemeIcon
                        radius="xl"
                        size={isMinimalLayout ? 42 : isCompactLayout ? 46 : 50}
                        variant="gradient"
                        gradient={{ from: '#112434', to: '#2d7a91', deg: 160 }}
                      >
                        <IconBrain size={isMinimalLayout ? 20 : 24} />
                      </ThemeIcon>
                    </Indicator>
                  </Paper>
                </HoverCard.Target>

                <HoverCard.Dropdown className="engine-popover">
                  <Stack gap={8}>
                    <Text className="micro-label">当前模型</Text>
                    <Text fw={700} size="lg">
                      {routeLabel}
                    </Text>
                    <Text size="sm" c="dimmed">
                      {routeHint}
                    </Text>
                    <Text size="sm" c="dimmed">
                      当前只整理为计划或笔记，计划摘要按主题顺序更新。
                    </Text>
                  </Stack>
                </HoverCard.Dropdown>
              </HoverCard>

              <ActionIcon
                size={isMinimalLayout ? 46 : 54}
                radius="xl"
                variant="light"
                className="theme-toggle-button"
                onClick={openAiSettings}
                aria-label="打开模型设置"
                title="模型设置"
              >
                <IconSettings size={22} />
              </ActionIcon>

              <ActionIcon
                size={isMinimalLayout ? 46 : 54}
                radius="xl"
                variant="light"
                className="theme-toggle-button"
                onClick={toggleTheme}
                aria-label={computedColorScheme === 'dark' ? '切换到浅色主题' : '切换到深夜模式'}
              >
                {computedColorScheme === 'dark' ? <IconSunHigh size={22} /> : <IconMoonStars size={22} />}
              </ActionIcon>

              <Button
                className="inbox-button"
                radius="xl"
                variant="gradient"
                gradient={{ from: '#173347', to: '#4b8ab4', deg: 135 }}
                leftSection={<IconStack2 size={18} />}
                onClick={() => openInbox('plan')}
                size={isMinimalLayout ? 'md' : 'lg'}
              >
                收件箱
              </Button>
            </div>

            <Paper
              className={isMinimalLayout ? 'status-pill status-pill-minimal' : 'status-pill'}
              radius="xl"
              p={isMinimalLayout ? 'xs' : isCompactLayout ? 'xs' : 'sm'}
            >
              <Group gap="sm" wrap="nowrap">
                <ThemeIcon radius="xl" size={isMinimalLayout ? 30 : isCompactLayout ? 32 : 36} variant="light" color={pendingCount > 0 ? 'orange' : 'teal'}>
                  <IconClockHour4 size={isMinimalLayout ? 16 : 18} />
                </ThemeIcon>
                <div className="status-copy">
                  <Text fw={700} size={isMinimalLayout ? 'sm' : 'md'}>
                    {statusTitle}
                  </Text>
                  <Text size="sm" c="dimmed" lineClamp={1} className="status-detail">
                    {statusDetail}
                  </Text>
                </div>
              </Group>
            </Paper>
          </MotionDiv>

          <MotionDiv
            className={`hero-stage hero-stage-${layoutMode}`}
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.08 }}
          >
            <Paper className="composer-shell" radius={40} p="xl">
              <div className="composer-head">
                <div>
                  <Text className="micro-label">AI Inbox</Text>
                  <Title order={1} className="composer-title">
                    {heroTitle}
                  </Title>
                </div>
                {!isMinimalLayout ? (
                  <Badge variant="light" color="gray" size={isCompactLayout ? 'md' : 'lg'} className="composer-badge">
                    只分计划与笔记
                  </Badge>
                ) : null}
              </div>

              <Paper className="composer-panel" radius={32} p="md">
                <div className="composer-type-row">
                  {!isMinimalLayout ? <Text className="micro-label composer-type-label">输入类型</Text> : null}
                  <Group gap="xs" className="composer-type-pills">
                    {composerTypeOptions.map((option) => {
                      const active = composerType === option
                      return (
                        <Button
                          key={option}
                          size="xs"
                          radius="xl"
                          variant={active ? 'filled' : 'light'}
                          color={active ? 'dark' : 'gray'}
                          className={active ? 'composer-type-pill composer-type-pill-active' : 'composer-type-pill'}
                          onClick={() => setComposerType(option)}
                        >
                          {composerTypeLabels[option]}
                        </Button>
                      )
                    })}
                  </Group>
                </div>

                <div className="composer-input-wrap">
                  <Textarea
                    value={draft}
                    onChange={(event) => setDraft(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault()
                        void handleSubmit()
                      }
                    }}
                    placeholder="比如：完成 AI 返回接口；推进教材封面替换；记录一下今天联调里最卡的两个问题。"
                    minRows={9}
                    variant="unstyled"
                    className="composer-field"
                  />
                </div>

                <div className="composer-footer">
                  {helperText ? (
                    <Text size="sm" c="dimmed" className="composer-helper">
                      {helperText}
                    </Text>
                  ) : (
                    <span />
                  )}
                  <Button
                    size={isMinimalLayout ? 'md' : 'lg'}
                    radius="xl"
                    rightSection={<IconSend2 size={18} />}
                    disabled={!draft.trim()}
                    onClick={() => void handleSubmit()}
                    variant="gradient"
                    gradient={{ from: '#143449', to: '#2d7a91', deg: 135 }}
                  >
                    发送
                  </Button>
                </div>
              </Paper>
            </Paper>
          </MotionDiv>
        </div>
      </Container>

      <Modal
        opened={aiSettingsOpened}
        onClose={closeAiSettings}
        title="模型设置"
        centered
        radius={28}
        size="lg"
        classNames={{
          content: 'settings-modal',
          header: 'settings-modal-header',
          body: 'settings-modal-body',
        }}
      >
        <Stack gap="md">
          <Text c="dimmed" size="sm">
            这里保存的是本地覆盖配置。保存后，后续新的 AI 整理请求会直接使用这套 Base URL、API Key 和 Model。
          </Text>

          <TextInput
            label="Base URL"
            placeholder="https://your-openai-compatible-endpoint.example/v1"
            value={aiSettingsDraft.baseUrl}
            onChange={(event) =>
              setAiSettingsDraft((current) => ({ ...current, baseUrl: event.currentTarget.value }))
            }
          />

          <PasswordInput
            label="API Key"
            placeholder="请输入 API Key"
            value={aiSettingsDraft.apiKey}
            onChange={(event) =>
              setAiSettingsDraft((current) => ({ ...current, apiKey: event.currentTarget.value }))
            }
          />

          <TextInput
            label="Model"
            placeholder="your-model-name"
            value={aiSettingsDraft.model}
            onChange={(event) =>
              setAiSettingsDraft((current) => ({ ...current, model: event.currentTarget.value }))
            }
          />

          <Paper className="settings-hint-card" radius={20} p="md">
            <Stack gap={6}>
              <Text className="micro-label">当前生效</Text>
              <Text fw={700}>{hasAiConfig() ? aiSettings.model : '本地兜底规则'}</Text>
              <Text size="sm" c="dimmed">
                {aiSettings.baseUrl || '尚未配置 Base URL'}
              </Text>
            </Stack>
          </Paper>

          <Group justify="space-between" wrap="wrap" gap="sm">
            <Button variant="subtle" color="gray" radius="xl" onClick={restoreDefaultAiSettings}>
              恢复默认
            </Button>

            <Group gap="sm" wrap="wrap">
              <Button variant="subtle" color="gray" radius="xl" onClick={closeAiSettings}>
                取消
              </Button>
              <Button radius="xl" onClick={saveAiSettingsDraft}>
                保存配置
              </Button>
            </Group>
          </Group>
        </Stack>
      </Modal>

      <Drawer
        opened={inboxOpened}
        onClose={() => setInboxOpened(false)}
        position="right"
        size={drawerSize}
        padding="lg"
        radius={28}
        classNames={{
          content: 'inbox-drawer',
          header: 'inbox-header',
          body: 'inbox-body',
        }}
        title={
          <div className="drawer-title-block">
            <Text className="micro-label">收件箱</Text>
            <Title order={2} className="drawer-title">
              {viewMeta[activeView].title}
            </Title>
          </div>
        }
      >
        <Stack gap="md" h="100%">
          <Group justify="space-between" align="center" wrap="wrap" className="drawer-toolbar">
            <Text c="dimmed" className="drawer-description" lineClamp={1}>
              {viewMeta[activeView].description}
            </Text>
            <SegmentedControl
              radius="xl"
              value={activeView}
              onChange={(value) => setActiveView(value as ActiveView)}
              data={(Object.keys(viewMeta) as ActiveView[]).map((view) => ({
                label: viewMeta[view].label,
                value: view,
              }))}
              className="drawer-switcher"
            />
          </Group>

          <ScrollArea className="drawer-scroll" offsetScrollbars>
            <Stack gap="md" pr="xs">
              <AnimatePresence mode="popLayout">
                {visibleTopics.map(({ topic, items }, index) => {
                  const summaryState = topic.summaryState ?? 'idle'
                  const summaryBusy = summaryState === 'queued' || summaryState === 'updating'
                  const isPlanTopic = topic.kind === 'plan'
                  const topicItems = isPlanTopic
                    ? items.filter((item) => item.interpretation?.type === 'task')
                    : items.filter((item) => item.interpretation?.type !== 'task')
                  const activeItems = isPlanTopic
                    ? topicItems.filter(({ entry }) => !isCompletedEntry(entry))
                    : topicItems
                  const completedItems = isPlanTopic
                    ? topicItems.filter(({ entry }) => isCompletedEntry(entry))
                    : []
                  return (
                    <MotionDiv
                      key={topic.id}
                      layout
                      initial={{ opacity: 0, y: 14 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      transition={{ duration: 0.22, delay: index * 0.02 }}
                    >
                      <Paper className={`${getTopicSurfaceClass(topic.kind)} ${isPlanTopic ? 'topic-surface-plan-dense' : ''}`} radius={24} p="md">
                        <Group
                          justify="space-between"
                          align="center"
                          wrap={isPlanTopic ? 'nowrap' : 'wrap'}
                          className={`topic-header-row ${isPlanTopic ? 'topic-header-row-plan' : ''}`}
                        >
                          <Group gap="sm" wrap="nowrap" className="topic-heading-row">
                            <Badge variant="light" color={getTopicColor(topic.kind)} size="md" className="topic-kind-chip">
                              {topicKindLabels[topic.kind]}
                            </Badge>
                            <Title order={3} className={`topic-title ${isPlanTopic ? 'topic-title-plan' : ''}`}>
                              {topic.name}
                            </Title>
                          </Group>
                          <Group
                            gap="xs"
                            justify="flex-end"
                            wrap={isPlanTopic ? 'nowrap' : 'wrap'}
                            className={`topic-meta-inline ${isPlanTopic ? 'topic-meta-inline-plan' : ''}`}
                          >
                            <Text size="sm" c="dimmed" className="topic-updated-at">
                              {timeLabel(topic.updatedAt)}
                            </Text>
                            {summaryState !== 'idle' ? (
                              <Badge
                                variant="light"
                                color={summaryBusy ? 'orange' : summaryState === 'error' ? 'red' : 'gray'}
                                className="topic-state-badge"
                              >
                                {summaryStateLabels[summaryState]}
                              </Badge>
                            ) : null}
                            {isPlanTopic ? (
                              <>
                                <Badge className="topic-count-badge topic-count-badge-plan" variant="light">
                                  进行中 {activeItems.length}
                                </Badge>
                                {completedItems.length > 0 ? (
                                  <Badge className="topic-count-badge topic-count-badge-completed" variant="light">
                                    已完成 {completedItems.length}
                                  </Badge>
                                ) : null}
                              </>
                            ) : (
                              <Badge className="topic-count-badge topic-count-badge-note" variant="light">
                                记录 {topicItems.length}
                              </Badge>
                            )}
                          </Group>
                        </Group>

                        {!isPlanTopic ? (
                          <Paper className={getSummaryBandClass(topic.kind)} radius={22} p="md" mt="md">
                            <Stack gap={8}>
                              <Text className="summary-label">概要</Text>
                              <Text>
                                {summaryBusy && !topic.summary
                                  ? '正在根据最新内容整理概要……'
                                  : topic.summary || '这个主题还没有生成概要，但原始内容已经完整保留。'}
                              </Text>
                            </Stack>
                          </Paper>
                        ) : null}

                        <Stack gap="xs" mt={isPlanTopic ? 'sm' : 'md'}>
                          {activeItems.map((item) => {
                            const { interpretation } = item
                            const isPlan = interpretation?.type === 'task'
                            if (isPlan) {
                              return renderPlanEntry(item)
                            }
                            return renderNoteEntry(item)
                          })}

                          {completedItems.length > 0 ? <Stack gap="xs">{completedItems.map((item) => renderCompletedPlanEntry(item))}</Stack> : null}
                        </Stack>
                      </Paper>
                    </MotionDiv>
                  )
                })}
              </AnimatePresence>

              {visibleLooseItems.length > 0 ? (
                <Paper
                  className={activeView === 'plan' ? 'topic-surface topic-surface-plan' : 'topic-surface topic-surface-note'}
                  radius={26}
                  p="lg"
                >
                  <Group justify="space-between" align="center" wrap="wrap" mb="md" className="topic-header-row">
                    <Group gap="sm" wrap="nowrap" className="topic-heading-row">
                      <Text className="micro-label">{activeView === 'plan' ? '未归组计划' : '未归组笔记'}</Text>
                      <Title order={3} className="topic-title topic-title-plan">
                        {activeView === 'plan' ? '暂未进入主题的计划' : '暂未进入主题的笔记'}
                      </Title>
                    </Group>
                    <Badge variant="light" color={activeView === 'plan' ? 'cyan' : 'orange'}>
                      {visibleLooseItems.length}
                    </Badge>
                  </Group>

                  <Stack gap="sm">
                    {visibleLooseItems.map((item) => {
                      const { entry, interpretation } = item
                      const isPlan = interpretation?.type === 'task'
                      const completed = isPlan && isCompletedEntry(entry)

                      if (completed) return renderCompletedPlanEntry(item)

                      if (isPlan) return renderPlanEntry(item)

                      return renderNoteEntry(item)
                    })}
                  </Stack>
                </Paper>
              ) : null}

              {appItems.length === 0 ? (
                <Paper className="empty-surface" radius={26} p="xl">
                  <ThemeIcon
                    radius="xl"
                    size={58}
                    variant="gradient"
                    gradient={{ from: '#d08a52', to: '#8f5978' }}
                    mx="auto"
                  >
                    <IconSparkles size={28} />
                  </ThemeIcon>
                  <Title order={2} ta="center" mt="md">
                    先写下一句真实的话，收件箱才会出现内容。
                  </Title>
                  <Text ta="center" mt="sm" c="dimmed">
                    例如“完成 AI 返回接口”或“今天发版延期的最大问题还是联调节奏慢”。
                  </Text>
                </Paper>
              ) : null}
            </Stack>
          </ScrollArea>
        </Stack>
      </Drawer>
    </div>
  )
}

export default App
