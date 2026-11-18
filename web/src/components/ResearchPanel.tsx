import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from '../api'
import {
  detectCollector,
  onAutoProgress,
  onAutoQueries,
  onCollectorStatus,
  type AutoProgress,
} from '../xhsBridge'
import {
  RESEARCH_CATEGORIES,
  RESEARCH_CATEGORY_LABELS,
  type ResearchCategory,
  type ResearchQuery,
  type ResearchRunSummary,
  type XhsCollectorStatus,
} from '../../../shared/types'

interface Props {
  /** 当前填写的旅行需求，手动重拆检索词时使用 */
  requirement: string
  configId: string
  model: string
  /** 最近三批线索总量变化时通知父组件（生成按钮上的提示用） */
  onTotalChange?: (total: number) => void
}

interface CollectorState extends XhsCollectorStatus {
  detected: boolean
}

const xhsDeepLink = (keyword: string): string =>
  `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}`

const INITIAL_COLLECTOR: CollectorState = {
  installed: false,
  version: '',
  lastLoginState: null,
  detected: false,
}

/**
 * 实采状态条（v1.4）。
 * 只显示「扩展/登录/本批条数/保留最近三次提问」这些状态，
 * 不再罗列已采集的线索——线索不出现在界面，只在生成时作为参考，
 * 具体笔记会以卡片形式挂在地点图册里（带封面与回源链接）。
 */
export default function ResearchPanel({ requirement, configId, model, onTotalChange }: Props) {
  const [collector, setCollector] = useState<CollectorState>(INITIAL_COLLECTOR)
  const [progress, setProgress] = useState<AutoProgress | null>(null)
  const [queries, setQueries] = useState<ResearchQuery[]>([])
  const [querySource, setQuerySource] = useState<'model' | 'rule' | ''>('')
  const [queryBusy, setQueryBusy] = useState(false)
  const [runs, setRuns] = useState<ResearchRunSummary[]>([])
  const [total, setTotal] = useState(0)
  const [keep, setKeep] = useState(3)
  const [activeCategory, setActiveCategory] = useState<ResearchCategory>('hotel')
  const [rawJson, setRawJson] = useState('')
  const [notice, setNotice] = useState('')
  const [noticeOk, setNoticeOk] = useState(false)
  const [busy, setBusy] = useState(false)

  const refreshSummary = useCallback(async () => {
    try {
      const summary = await api.researchSummary()
      setRuns(summary.runs)
      setTotal(summary.total)
      setKeep(summary.keep)
      onTotalChange?.(summary.total)
    } catch (_) {
      // 状态读取失败不打断主流程
    }
  }, [onTotalChange])

  /** 扩展状态：先主动握手，之后订阅扩展主动广播（含另一个标签页采集后的登录态） */
  const refreshCollector = useCallback(async () => {
    const status = await detectCollector()
    setCollector({ ...status, detected: status.installed })
  }, [])

  useEffect(() => {
    void refreshCollector()
    void refreshSummary()
    const offStatus = onCollectorStatus((status) => {
      setCollector((prev) => ({ ...status, detected: status.installed, lastLoginState: status.lastLoginState ?? prev.lastLoginState }))
    })
    const offProgress = onAutoProgress((update) => {
      setProgress(update)
      if (update.phase === 'done') void refreshSummary()
    })
    const offQueries = onAutoQueries((list) => {
      setQueries(list)
      setQuerySource('model')
    })
    return () => { offStatus(); offProgress(); offQueries() }
  }, [refreshCollector, refreshSummary])

  const genQueries = async () => {
    if (requirement.trim().length < 5) {
      setNotice('请先在上方填写旅行需求（至少 5 个字），再生成检索词。')
      setNoticeOk(false)
      return
    }
    setQueryBusy(true)
    setNotice('')
    try {
      const result = await api.researchQueries(requirement.trim(), configId, model.trim())
      setQueries(result.queries)
      setQuerySource(result.source)
      setNotice(`已生成 ${result.queries.length} 条分类检索词${result.source === 'rule' ? '（模型不可用，使用通用关键词）' : ''}。`)
      setNoticeOk(true)
    } catch (e) {
      setNotice(`检索词生成失败：${errorMessage(e)}`)
      setNoticeOk(false)
    } finally {
      setQueryBusy(false)
    }
  }

  const doImport = async () => {
    if (!rawJson.trim()) {
      setNotice('请先粘贴扩展采集并复制的 JSON。')
      setNoticeOk(false)
      return
    }
    setBusy(true)
    setNotice('')
    try {
      const parsed = JSON.parse(rawJson) as { loginChecked?: boolean; loggedIn?: boolean }
      if (!parsed.loginChecked || !parsed.loggedIn) {
        setNotice('这份 JSON 没有已登录凭证：请确认已登录小红书后重新采集（未登录时扩展不会生成凭证）。')
        setNoticeOk(false)
        return
      }
      const keyword = queries.find((q) => q.category === activeCategory)?.keyword ?? ''
      const result = await api.importResearch('', activeCategory, keyword, parsed)
      setRawJson('')
      await refreshSummary()
      setNotice(`已导入 ${result.imported} 条${result.skipped ? `，跳过 ${result.skipped} 条（重复或超量）` : ''}；本批共 ${result.total} 条。`)
      setNoticeOk(true)
    } catch (e) {
      setNotice(`导入失败：${errorMessage(e)}`)
      setNoticeOk(false)
    } finally {
      setBusy(false)
    }
  }

  const loginLabel = !collector.detected
    ? '待检测（自动采集时会检测）'
    : collector.lastLoginState === true
      ? '已登录 ✓'
      : collector.lastLoginState === false
        ? '未登录 ✕'
        : '将在生成时检测'

  const progressPercent = progress?.total ? Math.round(((progress.current ?? 0) / progress.total) * 100) : 0
  const latest = runs[0]

  return (
    <div className="research-strip">
      <div className="check-row">
        <span className={`check-item ${collector.installed ? 'ok' : 'off'}`}>
          <b>{collector.installed ? '✓' : '✕'}</b>
          采集扩展{collector.installed ? `已装${collector.version ? ` v${collector.version}` : ''}` : '未安装'}
        </span>
        <span className={`check-item ${collector.lastLoginState === true ? 'ok' : collector.lastLoginState === false ? 'off' : ''}`}>
          <b>{collector.lastLoginState === true ? '✓' : collector.lastLoginState === false ? '✕' : '·'}</b>
          小红书{loginLabel}
        </span>
        <span className="check-item">
          <b>{total}</b>条线索 · 保留最近 {keep} 次提问
        </span>
        <button className="btn ghost small" onClick={() => void refreshCollector()}>刷新状态</button>
      </div>

      {!collector.installed && (
        <p className="hint ev-warn">
          未检测到扩展：请在自己电脑的 Chrome/Edge 打开 <code>chrome://extensions</code>，开启开发者模式，
          加载仓库的 <code>tools/xhs-extension/</code> 目录（WorkBuddy 内置预览窗口无法加载扩展）。
        </p>
      )}

      {progress && (
        <div className="auto-progress">
          <div className="auto-progress-text">
            <span>{progress.phase === 'done' ? '完成' : '自动采集'}</span>
            <span>{progress.message}</span>
          </div>
          {progress.total && progress.phase === 'collect' && (
            <div className="auto-progress-track"><i style={{ width: `${progressPercent}%` }} /></div>
          )}
        </div>
      )}

      <p className="hint">
        {latest
          ? `最近一次提问「${latest.requirement.slice(0, 24) || '未填写需求'}」采集 ${latest.itemCount} 条，每次 30–50 条；线索不作列表展示，只用于生成，具体笔记会出现在地点图册里。`
          : '每次生成方案会自动采集 30–50 条小红书线索，只保留最近三次提问的线索，超出自动清理。'}
      </p>

      <details className="manual-import">
        <summary>高级：手动拆词 / 导入 JSON（自动采集失败时的兜底）</summary>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn small ghost" onClick={() => void genQueries()} disabled={queryBusy || busy}>
            {queryBusy ? '正在拆解…' : '重新拆解检索词'}
          </button>
          {querySource && <span className="hint">来源：{querySource === 'model' ? '模型生成' : '通用兜底'}</span>}
        </div>
        {queries.length > 0 && (
          <div className="query-grid">
            {RESEARCH_CATEGORIES.map((category) => {
              const categoryQueries = queries.filter((q) => q.category === category)
              return (
                <div className="query-cell" key={category}>
                  <h4>{RESEARCH_CATEGORY_LABELS[category]}</h4>
                  {categoryQueries.length === 0 && <span className="muted">—</span>}
                  {categoryQueries.map((q, i) => (
                    <a key={`${q.keyword}-${i}`} href={xhsDeepLink(q.keyword)} target="_blank" rel="noopener noreferrer">
                      {q.keyword} ↗
                    </a>
                  ))}
                </div>
              )
            })}
          </div>
        )}
        <div className="row" style={{ marginTop: 14 }}>
          <div className="field" style={{ flex: '0 0 160px' }}>
            <label htmlFor="research-category">线索分类</label>
            <select
              id="research-category"
              value={activeCategory}
              onChange={(e) => setActiveCategory(e.target.value as ResearchCategory)}
            >
              {RESEARCH_CATEGORIES.map((category) => (
                <option key={category} value={category}>{RESEARCH_CATEGORY_LABELS[category]}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="field" style={{ marginTop: 14 }}>
          <label htmlFor="research-json">扩展采集的 JSON（点扩展的「复制 JSON」后粘贴）</label>
          <textarea
            id="research-json"
            value={rawJson}
            onChange={(e) => setRawJson(e.target.value)}
            placeholder={'{\n  "loginChecked": true,\n  "loggedIn": true,\n  "items": [ ... ]\n}'}
          />
        </div>
        <div className="row">
          <button className="btn small" onClick={() => void doImport()} disabled={busy}>
            {busy ? '正在导入…' : `导入为${RESEARCH_CATEGORY_LABELS[activeCategory]}线索`}
          </button>
        </div>
        {notice && <p className={`hint ${noticeOk ? 'success-text' : 'ev-warn'}`}>{notice}</p>}
      </details>
    </div>
  )
}
