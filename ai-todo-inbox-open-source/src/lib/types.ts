export type EntryType = 'task' | 'analysis' | 'journal' | 'note'

export type TopicKind = 'plan' | 'insight' | 'journal-thread' | 'mixed'

export type EntryRecord = {
  id: string
  content: string
  createdAt: string
  source: 'manual'
  processingState: 'pending' | 'processing' | 'classified' | 'error'
  preferredType?: EntryType | null
  completedAt?: string | null
  reminderAt?: string | null
  reminderNotificationId?: number | null
  reminderScheduledAt?: string | null
  reminderTriggeredAt?: string | null
  reminderStatus?: 'idle' | 'scheduled' | 'triggered' | 'permission-denied' | 'past-due' | 'invalid-time'
  reminderReason?: string | null
}

export type TopicRecord = {
  id: string
  name: string
  kind: TopicKind
  summary: string
  createdAt: string
  updatedAt: string
  summaryState?: 'idle' | 'queued' | 'updating' | 'error'
}

export type InterpretationRecord = {
  entryId: string
  type: EntryType
  displayTitle: string
  rationale: string
  confidence: number
  topicId: string | null
  topicName: string | null
  topicKind: TopicKind | null
  topicSummary: string | null
  needsReview: boolean
  usedAi: boolean
  model: string | null
  createdAt: string
  typeSource?: 'auto' | 'manual'
}

export type TopicCandidate = Pick<TopicRecord, 'id' | 'name' | 'kind' | 'summary'>

export type AiClassification = {
  type: EntryType
  displayTitle: string
  rationale: string
  confidence: number
  topicId: string | null
  topicName: string | null
  topicKind: TopicKind | null
  topicSummary: string | null
  shouldCreateTopic: boolean
  needsReview: boolean
}

export type TopicSummaryInput = {
  content: string
  displayTitle: string
  createdAt: string
  type: EntryType
  completed: boolean
}

export type AppItem = {
  entry: EntryRecord
  interpretation: InterpretationRecord | null
}

export type TopicBundle = {
  topic: TopicRecord
  items: AppItem[]
}
