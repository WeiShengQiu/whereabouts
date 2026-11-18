import type {
  ApiResult,
  Evidence,
  EvidenceBundle,
  EvidenceInput,
  FileView,
  GenerationEvent,
  LLMConfigInput,
  LLMConfigUpdate,
  LLMConfigView,
  ModelInfo,
  PlanView,
  ResearchCategory,
  ResearchItem,
  ResearchQuery,
  SessionView,
  SourceStatus,
  UserView,
  XhsChannelStatus,
  XhsSearchResult,
} from '../../shared/types'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string> | undefined) },
  })
  const text = await response.text()
  let payload: ApiResult<T>
  try {
    payload = JSON.parse(text) as ApiResult<T>
  } catch {
    throw new Error(`服务返回异常（HTTP ${response.status}），请确认后端已启动`)
  }
  if (!payload.ok) throw new Error(payload.error)
  return payload.data
}

const post = <T,>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })

export interface ModelsResult {
  models: ModelInfo[]
  manualOnly: boolean
  reason: string
}

/** 生成任务的错误：message 给用户看，detail 保留上游原文与失败片段供展开排查 */
export class GenerationError extends Error {
  readonly detail?: string
  constructor(message: string, detail?: string) {
    super(message)
    this.name = 'GenerationError'
    this.detail = detail
  }
}

/** POST + SSE：用 fetch 读流，逐条把服务端事件交给调用方渲染 */
export async function streamRequest(
  path: string,
  body: unknown,
  onEvent: (event: GenerationEvent) => void,
): Promise<PlanView> {
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    let message = `服务返回异常（HTTP ${response.status}）`
    try {
      const payload = JSON.parse(await response.text()) as ApiResult<never>
      if (!payload.ok) message = payload.error
    } catch {
      // 非 JSON 错误响应保留默认提示
    }
    throw new GenerationError(message)
  }
  if (!response.body) throw new GenerationError('当前浏览器不支持流式响应，请更换现代浏览器')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result: PlanView | undefined
  let failure: GenerationError | undefined
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const chunks = buffer.split('\n\n')
    buffer = chunks.pop() ?? ''
    for (const chunk of chunks) {
      const line = chunk.split('\n').find((item) => item.startsWith('data: '))
      if (!line) continue
      let event: GenerationEvent
      try {
        event = JSON.parse(line.slice(6)) as GenerationEvent
      } catch {
        continue
      }
      onEvent(event)
      if (event.type === 'done' && event.result) result = event.result
      if (event.type === 'error') failure = new GenerationError(event.message, event.detail)
    }
  }
  if (failure) throw failure
  if (!result) throw new GenerationError('生成流意外中断，未收到完成事件，请检查后端日志')
  return result
}

export const api = {
  me: () => request<UserView>('/auth/me'),
  login: (email: string, password: string) => post<UserView>('/auth/login', { email, password }),
  register: (email: string, password: string) => post<UserView>('/auth/register', { email, password }),
  logout: () => post<{ loggedOut: boolean }>('/auth/logout'),
  sessions: () => request<SessionView[]>('/auth/sessions'),
  wechatStatus: () => request<{ enabled: boolean; reason: string }>('/auth/wechat/status'),

  configs: () => request<LLMConfigView[]>('/configs'),
  createConfig: (input: LLMConfigInput) => post<LLMConfigView>('/configs', input),
  updateConfig: (id: string, input: LLMConfigUpdate) =>
    request<LLMConfigView>(`/configs/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  deleteConfig: (id: string) => request<{ deleted: boolean }>(`/configs/${id}`, { method: 'DELETE' }),
  models: (id: string) => request<ModelsResult>(`/configs/${id}/models`),
  testConfig: (id: string, model: string) => post<{ ok: boolean; message: string }>(`/configs/${id}/test`, { model }),

  plans: () => request<PlanView[]>('/plans'),
  createPlan: (requirement: string, configId: string, model: string) =>
    post<PlanView>('/plans', { requirement, configId, model }),
  createPlanStream: (requirement: string, configId: string, model: string, onEvent: (e: GenerationEvent) => void) =>
    streamRequest('/plans/stream', { requirement, configId, model }, onEvent),
  selectOption: (id: string, optionIndex: number) => post<PlanView>(`/plans/${id}/select`, { optionIndex }),
  generateGuide: (id: string) => post<PlanView & { attempts: number }>(`/plans/${id}/guide`),
  generateGuideStream: (id: string, onEvent: (e: GenerationEvent) => void) =>
    streamRequest(`/plans/${id}/guide/stream`, {}, onEvent),
  exportHtml: (id: string) => post<FileView>(`/plans/${id}/export`),
  files: () => request<FileView[]>('/files'),

  evidenceSources: (poi: string, city = '') =>
    request<{ sources: SourceStatus[]; proxy: string; csvTemplate: string }>(
      `/evidence/sources?poi=${encodeURIComponent(poi)}&city=${encodeURIComponent(city)}`,
    ),
  evidence: () => request<Evidence[]>('/evidence'),
  evidenceMatrix: (pois: string[]) =>
    request<EvidenceBundle>(`/evidence/matrix?pois=${encodeURIComponent(pois.join(','))}`),
  addEvidence: (input: EvidenceInput) => post<Evidence>('/evidence', input),
  importEvidence: (csv: string) => post<{ imported: number }>('/evidence/import', { csv }),
  deleteEvidence: (id: string) => request<{ deleted: boolean }>(`/evidence/${id}`, { method: 'DELETE' }),
  xhsNotesStatus: () => request<XhsChannelStatus>('/evidence/xhs/status'),
  xhsNotesSearch: (keyword: string, limit: number) =>
    request<XhsSearchResult>(`/evidence/xhs/search?keyword=${encodeURIComponent(keyword)}&limit=${limit}`),

  // 小红书实采研究
  researchQueries: (requirement: string, configId: string, model: string) =>
    post<{ queries: ResearchQuery[]; source: 'model' | 'rule' }>('/xhs-research/queries', { requirement, configId, model }),
  research: () => request<ResearchItem[]>('/xhs-research'),
  importResearch: (category: ResearchCategory, keyword: string, payload: unknown) =>
    post<{ imported: number; skipped: number; reason?: string }>('/xhs-research/import', { category, keyword, payload }),
  deleteResearch: (id: string) => request<{ deleted: boolean }>(`/xhs-research/${id}`, { method: 'DELETE' }),
  clearResearch: () => request<{ deleted: number }>('/xhs-research', { method: 'DELETE' }),
}

export const downloadUrl = (id: string): string => `/api/files/${id}/download`

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
