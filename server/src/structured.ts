import { z } from 'zod'
import { chat, type ChatMessage, type ChatParams, type LLMConfigRecord } from './llm'

export interface StructuredEvent {
  kind: 'retry' | 'repaired'
  attempt: number
  message: string
  detail?: string
}
export type StructuredEmit = (event: StructuredEvent) => void

function jsonErrorContext(text: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const pos = /position (\d+)/.exec(message)
  if (!pos) return `JSON 解析失败：${message}`
  const at = Number(pos[1])
  return `JSON 解析失败：${message}｜出错位置附近原文：…${text.slice(Math.max(0, at - 80), at + 80)}…`
}

function formatSchemaError(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || '根节点'}: ${issue.message}`)
    .join('；')
}

/**
 * 把模型输出修成可解析的 JSON。用状态机而不是正则，才能区分「字符串内的引号」与结构符号。
 * 覆盖：Markdown 围栏、前后解释文字、字符串内裸换行/控制字符、数组元素间漏逗号、
 * 尾随逗号、以及达到 token 上限导致的字符串/容器未闭合。
 */
export function sanitizeJson(raw: string): string {
  let text = raw.trim().replace(/^\uFEFF/, '').replace(/[\u200B-\u200D]/g, '')
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) text = fence[1].trim()
  const start = text.indexOf('{')
  if (start > 0) text = text.slice(start)

  let out = ''
  let inString = false
  let escaped = false
  let lastSig = ''
  let sawObject = false
  let closedAt = -1
  const stack: string[] = []

  for (const ch of text) {
    if (inString) {
      if (escaped) {
        out += ch
        escaped = false
        continue
      }
      if (ch === '\\') {
        out += ch
        escaped = true
        continue
      }
      if (ch === '"') {
        out += ch
        inString = false
        lastSig = '"'
        continue
      }
      if (ch === '\n') {
        out += '\\n'
        continue
      }
      if (ch === '\r') {
        out += '\\r'
        continue
      }
      if (ch === '\t') {
        out += '\\t'
        continue
      }
      out += ch < ' ' ? ' ' : ch
      continue
    }

    if (/\s/.test(ch)) {
      out += ch
      continue
    }
    if (ch === '"' || ch === '{' || ch === '[') {
      // 合法 JSON 里，值开始前只可能是 [ { , : 或空白；否则说明上一个元素后漏了逗号
      if (lastSig && !'[{,:'.includes(lastSig)) out += ','
      if (ch === '"') {
        inString = true
      } else {
        stack.push(ch)
        sawObject = sawObject || ch === '{'
      }
      out += ch
      lastSig = ch
      continue
    }
    if (ch === '}' || ch === ']') {
      const top = stack[stack.length - 1]
      if ((ch === '}' && top === '{') || (ch === ']' && top === '[')) stack.pop()
      out += ch
      lastSig = ch
      if (stack.length === 0 && sawObject) {
        closedAt = out.length
        break
      }
      continue
    }
    out += ch
    lastSig = ch
  }

  if (closedAt >= 0) {
    out = out.slice(0, closedAt)
  } else {
    // 输出被截断：先闭合字符串，再按栈逆序补齐容器
    if (inString) {
      if (escaped) out = out.slice(0, -1)
      out += '"'
    }
    for (let i = stack.length - 1; i >= 0; i -= 1) out += stack[i] === '{' ? '}' : ']'
  }
  return out.replace(/,(\s*[}\]])/g, '$1').trim()
}

export function parseStructured<T>(raw: string, schema: z.ZodType<T>): { value: T; repaired: boolean } {
  const cleaned = sanitizeJson(raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch (error) {
    try {
      parsed = JSON.parse(raw.trim())
    } catch {
      throw new Error(jsonErrorContext(cleaned, error))
    }
  }
  try {
    return { value: schema.parse(parsed), repaired: cleaned !== raw.trim() }
  } catch (error) {
    if (error instanceof z.ZodError) throw new Error(`模型输出字段不符合要求：${formatSchemaError(error)}`)
    throw error
  }
}

export interface StructuredResult<T> {
  value: T
  attempts: number
  repaired: boolean
}

/** 失败时把「具体错在哪 + 原文片段」回传给模型，并降温、放宽 token，而不是重复同一句提示 */
export async function chatStructured<T>(
  config: LLMConfigRecord,
  params: ChatParams,
  schema: z.ZodType<T>,
  options: { maxAttempts?: number; emit?: StructuredEmit } = {},
): Promise<StructuredResult<T>> {
  const maxAttempts = options.maxAttempts ?? 3
  let lastError = ''
  let lastRaw = ''
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const messages: ChatMessage[] = [...params.messages]
    if (attempt > 1) {
      const fix =
        `\n\n【重要】上一次输出无法解析：${lastError.slice(0, 350)}。` +
        '请重新输出完整且合法的 JSON 对象：不要解释文字、不要 Markdown 围栏；' +
        '字符串内不要出现未转义的半角双引号与换行；数组元素之间必须有逗号；确保对象与数组全部闭合。'
      const lastIndex = messages.length - 1
      const tail = messages[lastIndex]
      if (tail?.role === 'user') messages[lastIndex] = { role: 'user', content: tail.content + fix }
      else messages.push({ role: 'user', content: fix.trim() })
    }
    const result = await chat(config, {
      ...params,
      messages,
      temperature: attempt === 1 ? params.temperature : 0.2,
      maxTokens: attempt === 1 ? params.maxTokens : Math.round((params.maxTokens ?? 4096) * 1.3),
    })
    lastRaw = result.text
    try {
      const parsed = parseStructured(lastRaw, schema)
      if (parsed.repaired) {
        options.emit?.({ kind: 'repaired', attempt, message: '模型输出有格式瑕疵，已自动修复后校验通过' })
      }
      return { ...parsed, attempts: attempt }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      options.emit?.({
        kind: 'retry',
        attempt,
        message: `第 ${attempt} 次输出解析失败${attempt < maxAttempts ? '，正在自动重试' : ''}`,
        detail: lastError,
      })
    }
  }
  throw new Error(
    `模型连续 ${maxAttempts} 次未返回合法的结构化内容：${lastError.slice(0, 260)}` +
      `｜最后一次输出结尾：…${lastRaw.slice(-160)}`,
  )
}
