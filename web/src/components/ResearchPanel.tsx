import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from '../api'
import {
  RESEARCH_CATEGORIES,
  RESEARCH_CATEGORY_LABELS,
  type ResearchCategory,
  type ResearchItem,
  type ResearchQuery,
  type XhsCollectorStatus,
} from '../../../shared/types'

interface Props {
  /** 当前填写的旅行需求，用于生成分类检索词 */
  requirement: string
  configId: string
  model: string
  /** 线索数量变化时通知父组件（用于生成按钮上的提示） */
  onCountChange?: (count: number) => void
}

interface CollectorState extends XhsCollectorStatus {
  detected: boolean
}

const xhsDeepLink = (keyword: string): string =>
  `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}`

/** 平台读取扩展注入的标记（installed/最近登录态），供「检查项」展示 */
function readCollector(): CollectorState {
  const marker = (window as unknown as { __XHS_COLLECTOR__?: XhsCollectorStatus }).__XHS_COLLECTOR__
  if (!marker || !marker.installed) {
    return { installed: false, version: '', lastLoginState: null, detected: false }
  }
  return {
    installed: true,
    version: marker.version,
    lastLoginState: marker.lastLoginState ?? null,
    detected: true,
  }
}

export default function ResearchPanel({ requirement, configId, model, onCountChange }: Props) {
  const [collector, setCollector] = useState<CollectorState>(() => readCollector())
  const [queries, setQueries] = useState<ResearchQuery[]>([])
  const [querySource, setQuerySource] = useState<'model' | 'rule' | ''>('')
  const [queryBusy, setQueryBusy] = useState(false)
  const [items, setItems] = useState<ResearchItem[]>([])
  const [activeCategory, setActiveCategory] = useState<ResearchCategory>('hotel')
  const [rawJson, setRawJson] = useState('')
  const [notice, setNotice] = useState('')
  const [noticeOk, setNoticeOk] = useState(false)
  const [busy, setBusy] = useState(false)

  const refreshCollector = useCallback(() => setCollector(readCollector()), [])

  useEffect(() => {
    refreshCollector()
    window.addEventListener('xhs-collector-status', refreshCollector)
    return () => window.removeEventListener('xhs-collector-status', refreshCollector)
  }, [refreshCollector])

  useEffect(() => {
    api.research()
      .then((list) => { setItems(list); onCountChange?.(list.length) })
      .catch(() => { /* 首次加载失败不打断主流程 */ })
  }, [onCountChange])

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
    if (!collector.installed) {
      setNotice('未检测到采集扩展：请先在浏览器安装并加载扩展，再执行采集。')
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
        setBusy(false)
        return
      }
      const keyword = queries.find((q) => q.category === activeCategory)?.keyword ?? ''
      const result = await api.importResearch(activeCategory, keyword, parsed)
      const list = await api.research()
      setItems(list)
      onCountChange?.(list.length)
      setRawJson('')
      setNotice(`已导入 ${result.imported} 条${result.skipped ? `，跳过 ${result.skipped} 条（重复或非小红书链接）` : ''}。`)
      setNoticeOk(true)
    } catch (e) {
      setNotice(`导入失败：${errorMessage(e)}`)
      setNoticeOk(false)
    } finally {
      setBusy(false)
    }
  }

  const removeItem = async (id: string) => {
    try {
      await api.deleteResearch(id)
      const list = await api.research()
      setItems(list)
      onCountChange?.(list.length)
    } catch (e) {
      setNotice(errorMessage(e))
      setNoticeOk(false)
    }
  }

  const clearAll = async () => {
    if (!window.confirm('确定清空全部实采线索？生成中的规划不受影响（已保存快照）。')) return
    try {
      await api.clearResearch()
      setItems([])
      onCountChange?.(0)
      setNotice('已清空全部实采线索。')
      setNoticeOk(true)
    } catch (e) {
      setNotice(errorMessage(e))
      setNoticeOk(false)
    }
  }

  const loginLabel = !collector.detected
    ? '待检测（采集后同步）'
    : collector.lastLoginState === true
      ? '已登录 ✓'
      : collector.lastLoginState === false
        ? '未登录 ✕'
        : '未检测'

  return (
    <div className="card research-card">
      <div className="card-head">
        <h2>小红书实采线索</h2>
        <span className="card-index">02 / 实采</span>
      </div>
      <p className="sub">
        先让模型把需求拆成酒店/交通/饮食/景点检索词，你用自己的浏览器和登录态在小红书采集真实笔记，
        导入后这些线索会作为参考注入方案与指南（非评分，需回源核实）。
      </p>

      {/* 检查项：扩展安装 + 小红书登录 */}
      <div className="check-row">
        <span className={`check-item ${collector.installed ? 'ok' : 'off'}`}>
          <b>{collector.installed ? '✓' : '✕'}</b>
          采集扩展{collector.installed ? `已安装${collector.version ? ` (v${collector.version})` : ''}` : '未安装'}
        </span>
        <span className={`check-item ${collector.lastLoginState === true ? 'ok' : collector.lastLoginState === false ? 'off' : ''}`}>
          <b>{collector.lastLoginState === true ? '✓' : collector.lastLoginState === false ? '✕' : '·'}</b>
          小红书{loginLabel}
        </span>
        <button className="btn small ghost" onClick={refreshCollector}>刷新状态</button>
      </div>
      {!collector.installed && (
        <p className="hint ev-warn">
          未检测到扩展：打开 <code>chrome://extensions</code> 开启开发者模式，加载仓库的 <code>tools/xhs-extension/</code> 目录。
          安装后回到本页点「刷新状态」。
        </p>
      )}

      <div className="sep" />

      {/* 分类检索词 */}
      <div className="row">
        <button className="btn" onClick={() => void genQueries()} disabled={queryBusy || busy}>
          {queryBusy ? '正在拆解检索词…' : '按需求生成检索词'}
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

      <div className="sep" />

      {/* 采集导入：选分类 + 粘贴 JSON */}
      <div className="row">
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
        <button className="btn primary" onClick={() => void doImport()} disabled={busy || !collector.installed}>
          {busy ? '正在导入…' : `导入为${RESEARCH_CATEGORY_LABELS[activeCategory]}线索`}
        </button>
        {items.length > 0 && <button className="btn ghost" onClick={() => void clearAll()}>清空全部</button>}
      </div>
      {notice && <p className={`hint ${noticeOk ? 'success-text' : 'ev-warn'}`}>{notice}</p>}

      {/* 已采集线索列表 */}
      {items.length > 0 && (
        <>
          <div className="sep" />
          <h4 className="section-title">已采集线索（{items.length}）</h4>
          <div className="research-list">
            {items.map((item) => (
              <div className="research-item" key={item.id}>
                <div>
                  <span className="badge">{RESEARCH_CATEGORY_LABELS[item.category]}</span>
                  <a href={item.url} target="_blank" rel="noopener noreferrer">{item.title || '（无标题）'}</a>
                </div>
                <div className="muted research-meta">
                  {item.author ? `@${item.author}` : ''}
                  {item.likes !== null ? ` · 热度 ${item.likes}` : ''}
                  {item.keyword ? ` · ${item.keyword}` : ''}
                </div>
                <button className="btn ghost small" onClick={() => void removeItem(item.id)}>删除</button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
