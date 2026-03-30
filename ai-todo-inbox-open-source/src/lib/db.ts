import Dexie, { type Table } from 'dexie'
import type { EntryRecord, InterpretationRecord, TopicRecord } from './types'

class TodoInboxDb extends Dexie {
  entries!: Table<EntryRecord, string>
  interpretations!: Table<InterpretationRecord, string>
  topics!: Table<TopicRecord, string>

  constructor() {
    super('ai-todo-inbox-db')

    this.version(1).stores({
      entries: 'id, createdAt, processingState',
      interpretations: 'entryId, type, topicId, createdAt',
      topics: 'id, kind, updatedAt, name',
    })

    this.version(2).stores({
      entries: 'id, createdAt, processingState, reminderAt, reminderNotificationId',
      interpretations: 'entryId, type, topicId, createdAt',
      topics: 'id, kind, updatedAt, name',
    })

    this.version(3).stores({
      entries: 'id, createdAt, processingState, reminderAt, reminderNotificationId, reminderStatus',
      interpretations: 'entryId, type, topicId, createdAt',
      topics: 'id, kind, updatedAt, name',
    })

    this.version(4).stores({
      entries: 'id, createdAt, processingState, reminderAt, reminderNotificationId, reminderStatus, reminderTriggeredAt',
      interpretations: 'entryId, type, topicId, createdAt',
      topics: 'id, kind, updatedAt, name',
    })
  }
}

export const db = new TodoInboxDb()
