import { invoke } from '@tauri-apps/api/core'
import { aiSettings } from './ai-config'
import { isDesktopRuntime } from './runtime'
import type { AiClassification, EntryType, TopicCandidate, TopicKind, TopicSummaryInput } from './types'

type ChatMessage = {
  role: 'system' | 'user'
  content: string
}

type OpenAiResponse = {
  error?: {
    code?: string
    message?: string
    param?: string
    type?: string
  }
  choices?: Array<{
    message?: {
      content?: string
    }
  }>
}

const TOPIC_KINDS: TopicKind[] = ['plan', 'insight', 'journal-thread', 'mixed']

const classificationPrompt = `You are an inbox organizer for a local-first productivity app.

Your job:
1. Classify one user input as exactly one of: task, note.
2. Decide whether it belongs to an existing topic candidate.
3. If no topic fits and it is a task, propose a short topic name and topic kind.
4. Return a concise display title. If the original text is already short and clear, keep it close to the original meaning.
5. Preserve the original meaning. Do not invent facts.

Rules:
- task: actionable work to do, something that can be completed or tracked in a plan.
- note: any thought, summary, diary-like text, discussion, record, or fragment that should not become a plan item.
- Only use an existing topicId when it is clearly the same scene or function.
- If confidence is below 0.72, set needsReview to true.
- topicKind must be "plan" for tasks.
- topicKind must never be "plan" for notes. For note topics, prefer "mixed" unless an existing note topic clearly fits better.
- For task topics, prefer broader stable topic names that can absorb close variants. Example: use "AI 接口" instead of splitting close variants into separate plan topics.
- topicSummary should usually be null at classification time.

Return JSON only. No markdown fences.`

const planSummaryPrompt = `You summarize one plan topic in a local-first inbox app.

Your job:
1. Read the topic metadata and all current entries in that topic.
2. Produce one concise Chinese summary.
3. Keep the summary grounded in the provided entries only.

Rules:
- Summarize the shared goal and current sub-items.
- When some items are completed, mention that briefly.
- Prefer 1 to 3 short Chinese sentences.
- Avoid bullet points, markdown, or headings.

Return JSON only with: { "summary": "..." }.`

const noteSummaryPrompt = `You polish one note topic in a local-first inbox app.

Your job:
1. Read the topic metadata and all current note entries in that topic.
2. Merge overlapping ideas into one concise Chinese summary.
3. Improve wording and readability, but do not invent facts.

Rules:
- Focus on the shared theme, conclusions, and notable details.
- This is not a task list. Do not rewrite it as action items unless the entries explicitly say so.
- Prefer 1 to 3 short Chinese sentences with smoother wording than the raw notes.
- Avoid bullet points, markdown, or headings.

Return JSON only with: { "summary": "..." }.`

const MANUAL_TYPE_RULES: Record<EntryType, string> = {
  task: 'The entry type is fixed to task because the user selected it manually. Do not change the type.',
  analysis: 'Ignore this label and treat it as note. The product only supports task or note.',
  journal: 'Ignore this label and treat it as note. The product only supports task or note.',
  note: 'The entry type is fixed to note because the user selected it manually. Do not change the type.',
}

const TASK_ACTION_TERMS = [
  '导出',
  '导入',
  '发送',
  '提交',
  '交付',
  '同步',
  '上线',
  '实现',
  '修复',
  '整理',
  '撰写',
  '联调',
  '部署',
  '测试',
  '发布',
  '评审',
  '跟进',
  '确认',
  '处理',
  '推进',
  '补充',
]

const GENERIC_PLAN_TOPIC_PATTERN =
  /(相关工作|相关事项|相关内容|工作事项|工作安排|任务安排|任务计划|计划事项|事项推进)$/
const AMBIGUOUS_SOURCE_PATTERN = /(这个|那个|到时候|回头|看一下|弄一下|搞一下|处理一下)/

export { aiSettings }

function usesRelativeProxy() {
  return aiSettings.baseUrl.startsWith('/')
}

export function hasAiConfig() {
  return Boolean(aiSettings.baseUrl && aiSettings.model && (usesRelativeProxy() || aiSettings.apiKey))
}

function safeParseJson(content: string) {
  const trimmed = content.trim()

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return JSON.parse(trimmed)
  }

  const match = trimmed.match(/\{[\s\S]*\}/)
  if (!match) {
    throw new Error('AI did not return JSON')
  }

  return JSON.parse(match[0])
}

function normalizeType(value: string, topicKind: TopicKind | null, title: string, rationale: string): EntryType {
  const lower = `${value} ${title} ${rationale}`.toLowerCase()

  if (value === 'task') return 'task'
  if (topicKind === 'plan') return 'task'

  if (/(task|todo|action|plan|work|fix|implement|notification|issue)/.test(lower)) {
    return 'task'
  }

  return 'note'
}

function isPlanTopicKind(kind: TopicKind | null | undefined) {
  return kind === 'plan'
}

function isNoteTopicKind(kind: TopicKind | null | undefined) {
  return Boolean(kind && kind !== 'plan')
}

function normalizeTopicKind(value: unknown, type: EntryType): TopicKind | null {
  if (type === 'task') return 'plan'

  if (value && TOPIC_KINDS.includes(value as TopicKind) && isNoteTopicKind(value as TopicKind)) {
    return value as TopicKind
  }

  return null
}

function normalizePreferredType(preferredType?: EntryType | null): EntryType | null {
  if (!preferredType) return null
  return preferredType === 'task' ? 'task' : 'note'
}

function squeezeWhitespace(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function normalizeForCompare(value: string) {
  return squeezeWhitespace(value).toLowerCase()
}

function clampConfidence(value: number) {
  if (Number.isNaN(value)) return 0.5
  return Math.max(0, Math.min(1, value))
}

function lightlyRewriteTitle(value: string) {
  return squeezeWhitespace(
    value
      .replace(/[。！？!?，,；;、]+$/g, '')
      .replace(/^(请|请帮我|麻烦|记得|需要)\s*/g, '')
      .replace(/^(帮我|给我|替我)\s*/g, '')
      .replace(/^(今天|明天|后天|今晚|早上|上午|中午|下午|晚上)\s*/g, ''),
  )
}

function stripTimeHints(value: string) {
  return squeezeWhitespace(
    value
      .replace(/^(今天|明天|后天|今晚|今早|早上|上午|中午|下午|晚上|凌晨)\s*/g, '')
      .replace(/^(本周|这周|下周|周[一二三四五六日天]|星期[一二三四五六日天])\s*/g, '')
      .replace(/^(?:\d{4}[年/-])?\d{1,2}[月/-]\d{1,2}[日号]?\s*/g, '')
      .replace(/^(?:上午|中午|下午|晚上|凌晨)?\s*(?:\d{1,2}[:：点]\d{0,2}分?)\s*/g, ''),
  )
}

function containsUnexpectedAction(raw: string, rewritten: string) {
  return TASK_ACTION_TERMS.some((term) => rewritten.includes(term) && !raw.includes(term))
}

function isRewriteTooDifferent(raw: string, rewritten: string) {
  const source = normalizeForCompare(raw)
  const target = normalizeForCompare(rewritten)
  if (!source || !target || source === target) return false
  if (target.includes(source) || source.includes(target)) return false

  const sharedChars = [...new Set(source)].filter((char) => target.includes(char)).length
  const baseline = Math.max(source.length, target.length)
  return baseline > 0 && sharedChars / baseline < 0.45
}

function shouldFallbackToRawTaskTitle(raw: string, displayTitle: string) {
  return containsUnexpectedAction(raw, displayTitle) || (AMBIGUOUS_SOURCE_PATTERN.test(raw) && isRewriteTooDifferent(raw, displayTitle))
}

function derivePlanTopicNameFromTitle(title: string) {
  const trimmed = stripTimeHints(lightlyRewriteTitle(title))
    .replace(/^(完成|处理|推进|安排|跟进|需要|记得|解决|优化)\s*/g, '')
    .replace(/^(一个|一下|一版|一轮)\s*/g, '')
    .replace(GENERIC_PLAN_TOPIC_PATTERN, '')
    .trim()

  if (!trimmed) return null

  const verbObjectMatch = trimmed.match(
    /^(导出|导入|发送|提交|交付|同步|上线|实现|修复|整理|撰写|联调|部署|测试|发布|评审|跟进|确认|处理|推进|补充)(.+)$/,
  )

  if (verbObjectMatch) {
    const [, action, object] = verbObjectMatch
    const normalizedObject = object.replace(/^(一个|一份|一套|一下)\s*/g, '').trim()
    if (normalizedObject) return `${normalizedObject}${action}`
  }

  return trimmed
}

function postProcessClassification(input: string, result: AiClassification, preferredType?: EntryType | null): AiClassification {
  const forcedType = normalizePreferredType(preferredType)
  const raw = squeezeWhitespace(input)
  const next: AiClassification = {
    ...result,
    displayTitle: squeezeWhitespace(result.displayTitle || raw),
    confidence: clampConfidence(result.confidence),
    needsReview: forcedType ? false : Boolean(result.needsReview),
    topicName: result.topicName ? squeezeWhitespace(result.topicName) : null,
  }

  if (next.type !== 'task') {
    if (!next.displayTitle) next.displayTitle = raw
    return next
  }

  if (shouldFallbackToRawTaskTitle(raw, next.displayTitle)) {
    next.displayTitle = lightlyRewriteTitle(raw) || raw
    next.confidence = Math.min(next.confidence, 0.66)
    next.needsReview = true

    if (!next.topicId) {
      next.topicName = null
      next.shouldCreateTopic = false
      next.topicKind = null
    }

    return next
  }

  if (!next.displayTitle) {
    next.displayTitle = lightlyRewriteTitle(raw) || raw
  }

  if (!next.topicId) {
    if (next.topicName && GENERIC_PLAN_TOPIC_PATTERN.test(next.topicName)) {
      next.topicName = derivePlanTopicNameFromTitle(next.displayTitle)
    }

    if (!next.topicName) {
      next.topicName = derivePlanTopicNameFromTitle(next.displayTitle)
    }

    if (!next.topicName) {
      next.shouldCreateTopic = false
      next.topicKind = null
    } else {
      next.topicKind = 'plan'
    }
  }

  return next
}

function fallbackClassification(input: string, preferredType?: EntryType | null): AiClassification {
  const content = input.trim()
  const lower = content.toLowerCase()
  const forcedType = normalizePreferredType(preferredType)

  const taskSignals = ['完成', '修复', '对接', '补充', '发版', '处理', '新增', '实现', '安排', '推进', 'update', 'fix']

  let type: EntryType = forcedType ?? 'note'
  if (!forcedType && taskSignals.some((signal) => lower.includes(signal.toLowerCase()))) {
    type = 'task'
  }

  return {
    type,
    displayTitle: content,
    rationale: 'AI 未配置或返回异常，已改用本地兜底规则。',
    confidence: 0.58,
    topicId: null,
    topicName: null,
    topicKind: normalizeTopicKind(null, type),
    topicSummary: null,
    shouldCreateTopic: type === 'task',
    needsReview: !forcedType,
  }
}

function fallbackSummary(topicName: string, items: TopicSummaryInput[]) {
  const recent = items.slice(-4)
  const active = recent.filter((item) => !item.completed)
  const completed = recent.filter((item) => item.completed)
  const activeText = active.map((item) => item.displayTitle || item.content).join('；')
  const completedText = completed.map((item) => item.displayTitle || item.content).join('；')

  if (activeText && completedText) {
    return `${topicName}：进行中 ${activeText}；已完成 ${completedText}。`
  }

  if (activeText) return `${topicName}：${activeText}。`
  if (completedText) return `${topicName}：已完成 ${completedText}。`
  return `${topicName}：暂时没有摘要。`
}

function fallbackNoteSummary(topicName: string, items: TopicSummaryInput[]) {
  const recent = items.slice(-4)
  const mergedText = recent.map((item) => item.displayTitle || item.content).join('；')
  if (!mergedText) return `${topicName}：暂时没有摘要。`
  return `${topicName}：${mergedText}。`
}

function buildClassificationUserPrompt(input: string, candidates: TopicCandidate[], preferredType?: EntryType | null) {
  return JSON.stringify(
    {
      input,
      preferredType: normalizePreferredType(preferredType),
      existingTopics: candidates.map((topic) => ({
        id: topic.id,
        name: topic.name,
        kind: topic.kind,
        summary: topic.summary,
      })),
      outputSchema: {
        type: 'task | note',
        displayTitle: 'string',
        rationale: 'string',
        confidence: 'number between 0 and 1',
        topicId: 'string | null',
        topicName: 'string | null',
        topicKind: 'plan | insight | journal-thread | mixed | null',
        topicSummary: 'string | null',
        shouldCreateTopic: 'boolean',
        needsReview: 'boolean',
      },
    },
    null,
    2,
  )
}

function buildSummaryUserPrompt(
  topicName: string,
  topicKind: TopicKind,
  previousSummary: string,
  items: TopicSummaryInput[],
) {
  return JSON.stringify(
    {
      topic: {
        name: topicName,
        kind: topicKind,
        previousSummary,
      },
      entries: items.map((item) => ({
        createdAt: item.createdAt,
        type: item.type,
        displayTitle: item.displayTitle,
        content: item.content,
        completed: item.completed,
      })),
      outputSchema: {
        summary: 'string',
      },
    },
    null,
    2,
  )
}

async function requestJson(messages: ChatMessage[]) {
  if (isDesktopRuntime()) {
    return requestJsonDesktop(messages)
  }

  return requestJsonWeb(messages)
}

async function requestJsonDesktop(messages: ChatMessage[]) {
  if (usesRelativeProxy()) {
    throw new Error('桌面客户端不能使用相对 /api 地址。请打开右上角模型设置，把 Base URL 改成完整接口地址，并填写 API Key。')
  }

  const request = async (useJsonResponseFormat: boolean) =>
    invoke<OpenAiResponse>('ai_chat_completion', {
      payload: {
        baseUrl: aiSettings.baseUrl,
        apiKey: aiSettings.apiKey,
        model: aiSettings.model,
        messages,
        useJsonResponseFormat,
      },
    })

  try {
    return await request(true)
  } catch (error) {
    const message = buildAiErrorMessage(error)
    if (!message.includes('json_object')) {
      throw error
    }

    return request(false)
  }
}

async function requestJsonWeb(messages: ChatMessage[]) {
  if (usesRelativeProxy() && typeof window !== 'undefined' && window.location.origin.includes('tauri.localhost')) {
    throw new Error('当前桌面客户端仍在使用旧的 /api 配置，请打开右上角模型设置并填写完整的 Base URL。')
  }

  const baseUrl = aiSettings.baseUrl.replace(/\/$/, '')

  const request = async (useJsonResponseFormat: boolean) => {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(usesRelativeProxy() ? {} : { Authorization: `Bearer ${aiSettings.apiKey}` }),
      },
      body: JSON.stringify({
        model: aiSettings.model,
        temperature: 0.2,
        ...(useJsonResponseFormat ? { response_format: { type: 'json_object' } } : {}),
        messages,
      }),
    })

    const responseText = await response.text()
    const contentType = response.headers.get('content-type') ?? ''

    if (!contentType.includes('application/json') && /<!doctype html>|<html/i.test(responseText)) {
      throw new Error('AI 接口返回了 HTML 页面。请检查 base URL 是否正确。')
    }

    let data: OpenAiResponse
    try {
      data = JSON.parse(responseText) as OpenAiResponse
    } catch {
      throw new Error(`AI 接口没有返回合法 JSON。前 120 个字符：${responseText.slice(0, 120)}`)
    }

    if (!response.ok) {
      const errorMessage = data.error?.message || `AI request failed with status ${response.status}`
      throw new Error(errorMessage)
    }

    return data
  }

  try {
    return await request(true)
  } catch (error) {
    const message = buildAiErrorMessage(error)
    if (!message.includes('json_object')) {
      throw error
    }

    return request(false)
  }
}

export async function classifyEntry(
  input: string,
  candidates: TopicCandidate[],
  preferredType?: EntryType | null,
): Promise<AiClassification> {
  if (!hasAiConfig()) {
    return fallbackClassification(input, preferredType)
  }

  const forcedType = normalizePreferredType(preferredType)
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: forcedType ? `${classificationPrompt}\n\n${MANUAL_TYPE_RULES[forcedType]}` : classificationPrompt,
    },
    { role: 'user', content: buildClassificationUserPrompt(input, candidates, forcedType) },
  ]

  const data = await requestJson(messages)
  const content = data.choices?.[0]?.message?.content

  if (!content) {
    throw new Error('AI response did not include content')
  }

  const parsed = safeParseJson(content)
  const preliminaryTopicKind = normalizeTopicKind(parsed.topicKind, 'note')
  const type = forcedType
    ? forcedType
    : normalizeType(
        String(parsed.type || ''),
        preliminaryTopicKind,
        String(parsed.displayTitle || ''),
        String(parsed.rationale || ''),
      )

  return postProcessClassification(
    input,
    {
      type,
      displayTitle: String(parsed.displayTitle || input.trim()),
      rationale: String(parsed.rationale || ''),
      confidence: Number(parsed.confidence ?? 0.5),
      topicId: typeof parsed.topicId === 'string' && parsed.topicId ? parsed.topicId : null,
      topicName: typeof parsed.topicName === 'string' && parsed.topicName ? parsed.topicName : null,
      topicKind: normalizeTopicKind(parsed.topicKind, type),
      topicSummary: typeof parsed.topicSummary === 'string' && parsed.topicSummary ? parsed.topicSummary : null,
      shouldCreateTopic: type === 'task' && Boolean(parsed.shouldCreateTopic || parsed.topicName || parsed.topicId),
      needsReview: forcedType ? false : Boolean(parsed.needsReview),
    },
    preferredType,
  )
}

export async function summarizeTopic(
  topicName: string,
  topicKind: TopicKind,
  previousSummary: string,
  items: TopicSummaryInput[],
) {
  if (items.length === 0) {
    return previousSummary || `${topicName}：暂时没有摘要。`
  }

  if (!hasAiConfig()) {
    return isPlanTopicKind(topicKind)
      ? fallbackSummary(topicName, items)
      : fallbackNoteSummary(topicName, items)
  }

  const trimmedItems = items.slice(-24)
  const messages: ChatMessage[] = [
    { role: 'system', content: isPlanTopicKind(topicKind) ? planSummaryPrompt : noteSummaryPrompt },
    { role: 'user', content: buildSummaryUserPrompt(topicName, topicKind, previousSummary, trimmedItems) },
  ]

  const data = await requestJson(messages)
  const content = data.choices?.[0]?.message?.content

  if (!content) {
    throw new Error('AI response did not include content')
  }

  const parsed = safeParseJson(content)
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : ''
  return (
    summary ||
    (isPlanTopicKind(topicKind)
      ? fallbackSummary(topicName, trimmedItems)
      : fallbackNoteSummary(topicName, trimmedItems))
  )
}

export function buildAiErrorMessage(error: unknown) {
  if (typeof error === 'string') {
    return error
  }

  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === 'object' && error && 'message' in error && typeof error.message === 'string') {
    return error.message
  }

  return 'Unknown AI error'
}
