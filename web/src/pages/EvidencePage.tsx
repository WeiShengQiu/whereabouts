import { useEffect, useState } from 'react'
import { api, errorMessage } from '../api'
import EvidenceMatrix from '../components/EvidenceMatrix'
import { EVIDENCE_SOURCES, EVIDENCE_SOURCE_LABELS } from '../../../shared/types'
import type {
  Evidence,
  EvidenceBundle,
  EvidenceInput,
  EvidenceSource,
  SourceStatus,
  XhsChannelStatus,
  XhsNote,
  XhsSearchResult,
} from '../../../shared/types'

interface Draft {
  poiName: string
  source: EvidenceSource
  rating: string
  ratingRaw: string
  ratingScale: string
  reviewCount: string
  url: string
  snippet: string
}

const EMPTY_DRAFT: Draft = {
  poiName: '',
  source: 'manual',
  rating: '',
  ratingRaw: '',
  ratingScale: '',
  reviewCount: '',
  url: '',
  snippet: '',
}

const STATE_LABEL: Record<SourceStatus['state'], string> = {
  ready: '已获取',
  no_key: '未启用',
  disabled: '已禁用',
  degraded: '已熔断',
  empty: '未获取',
}

const formatCount = (value: number | null): string => {
  if (value === null) return '—'
  return value >= 10_000 ? `${(value / 10_000).toFixed(1)}万` : String(value)
}

const XHS_SEARCH_FALLBACK = 'https://www.xiaohongshu.com/search_result'

export default function EvidencePage() {
  const [items, setItems] = useState<Evidence[]>([])
  const [sources, setSources] = useState<SourceStatus[]>([])
  const [proxy, setProxy] = useState('')
  const [csvTemplate, setCsvTemplate] = useState('')
  const [matrix, setMatrix] = useState<EvidenceBundle | null>(null)
  const [previewPoi, setPreviewPoi] = useState('')
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [csv, setCsv] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [xhsStatus, setXhsStatus] = useState<XhsChannelStatus | null>(null)
  const [xhsKeyword, setXhsKeyword] = useState('')
  const [xhsLimit, setXhsLimit] = useState('8')
  const [xhsResult, setXhsResult] = useState<XhsSearchResult | null>(null)
  const [xhsBusy, setXhsBusy] = useState(false)
  const [extJson, setExtJson] = useState('')
  const [extItems, setExtItems] = useState<Array<{ title: string; author: string; link: string; summary: string; likes: number | null }>>([])
  const [extNotice, setExtNotice] = useState('')

  const refresh = async (pois: string[] = []) => {
    const [list, sourceInfo, status] = await Promise.all([
      api.evidence(),
      api.evidenceSources(pois[0] ?? '目的地'),
      api.xhsNotesStatus(),
    ])
    setItems(list)
    setSources(sourceInfo.sources)
    setProxy(sourceInfo.proxy)
    setCsvTemplate(sourceInfo.csvTemplate)
    setXhsStatus(status)
    setMatrix(pois.length ? await api.evidenceMatrix(pois) : null)
  }

  useEffect(() => {
    void refresh().catch((e) => setError(errorMessage(e)))
  }, [])

  const run = async (task: () => Promise<void>, message: string) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await task()
      const pois = previewPoi.split(',').map((item) => item.trim()).filter(Boolean)
      await refresh(pois)
      setNotice(message)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const submitDraft = () => {
    if (draft.poiName.trim().length === 0) return setError('请填写地点名称')
    const payload: EvidenceInput = {
      poiName: draft.poiName.trim(),
      source: draft.source,
      rating: draft.rating.trim() === '' ? null : Number(draft.rating),
      ratingRaw: draft.ratingRaw,
      ratingScale: draft.ratingScale.trim() === '' ? null : Number(draft.ratingScale),
      reviewCount: draft.reviewCount.trim() === '' ? null : Number(draft.reviewCount),
      url: draft.url,
      snippet: draft.snippet,
      origin: 'manual',
    }
    void run(async () => {
      await api.addEvidence(payload)
      setDraft(EMPTY_DRAFT)
    }, '证据已保存，下次生成规划时会自动带入对比')
  }

  const setField = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((prev) => ({ ...prev, [key]: value }))

  const searchXhs = () => {
    const keyword = xhsKeyword.trim()
    if (keyword.length < 2) return setError('请填写至少 2 个字的检索关键词')
    setXhsBusy(true)
    setError('')
    setNotice('')
    void api
      .xhsNotesSearch(keyword, Number(xhsLimit) || 8)
      .then(async (result) => {
        setXhsResult(result)
        setXhsStatus(await api.xhsNotesStatus())
        setNotice(result.notice)
      })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setXhsBusy(false))
  }

  /** 只把标题与链接留作人工核对线索，不写入评分、不注入模型 */
  const saveNoteAsLead = (note: XhsNote) => {
    void run(async () => {
      await api.addEvidence({
        poiName: xhsKeyword.trim().slice(0, 60),
        source: 'xiaohongshu',
        rating: null,
        ratingRaw: '',
        ratingScale: null,
        reviewCount: null,
        url: note.url,
        snippet: `笔记：${note.title}${note.author ? ` · @${note.author}` : ''}`,
        origin: 'manual',
      })
    }, '已存为口碑线索（仅标题与链接，不含评分）')
  }

  /** 解析「行迹 · 小红书线索采集」扩展导出的 JSON；只接受白名单域名与固定 schema */
  interface ExtNote { title: string; author: string; link: string; summary: string; likes: number | null }
  const parseExtensionJson = (raw: string): ExtNote[] => {
    const parsed = JSON.parse(raw) as { schemaVersion?: number; items?: Array<Record<string, unknown>> }
    if (!parsed || !Array.isArray(parsed.items)) throw new Error('JSON 格式不正确：缺少 items 数组')
    const seen = new Set<string>()
    const out: ExtNote[] = []
    for (const it of parsed.items) {
      const title = typeof it.title === 'string' ? it.title.trim().slice(0, 200) : ''
      const author = typeof it.author === 'string' ? it.author.trim().slice(0, 80) : ''
      const link = typeof it.link === 'string' ? it.link.trim() : ''
      // 安全边界：只接受小红书官方域名的链接，其它一律丢弃
      if (!/^https:\/\/(www\.)?xiaohongshu\.com\//.test(link)) continue
      if (seen.has(link)) continue
      seen.add(link)
      const likes = typeof it.likes === 'number' && Number.isFinite(it.likes) ? it.likes : null
      const summary = typeof it.summary === 'string' ? it.summary.trim().slice(0, 500) : ''
      if (!title && !summary && !link) continue
      out.push({ title, author, link, summary, likes })
    }
    if (out.length === 0) throw new Error('没有可导入的有效笔记（需含小红书官方链接）')
    return out
  }

  const loadExtensionJson = (raw: string) => {
    setExtJson(raw)
    setExtNotice('')
    setExtItems([])
    if (!raw.trim()) return
    try {
      const items = parseExtensionJson(raw)
      setExtItems(items)
      setExtNotice(`已解析 ${items.length} 条有效笔记，确认后导入为口碑线索。`)
    } catch (e) {
      setExtNotice(`解析失败：${errorMessage(e)}`)
    }
  }

  const onExtFile = (file: File | undefined) => {
    if (!file) return
    void file.text().then((text) => loadExtensionJson(text))
  }

  /** 批量导入：与「存为线索」同构，只留标题/摘要/链接，不产生评分、不注入模型 */
  const importExtensionItems = () => {
    if (extItems.length === 0) return
    void run(async () => {
      for (const it of extItems) {
        const snippetParts = [`笔记：${it.title || '（无标题）'}`]
        if (it.author) snippetParts.push(`@${it.author}`)
        if (it.summary) snippetParts.push(it.summary)
        if (it.likes !== null) snippetParts.push(`赞 ${it.likes}`)
        await api.addEvidence({
          poiName: it.title.slice(0, 60) || '小红书笔记',
          source: 'xiaohongshu',
          rating: null,
          ratingRaw: '',
          ratingScale: null,
          reviewCount: null,
          url: it.link,
          snippet: snippetParts.join(' · ').slice(0, 800),
          origin: 'import',
        })
      }
      setExtItems([])
      setExtJson('')
    }, `已导入 ${extItems.length} 条口碑线索（不含评分）`)
  }

  return (
    <>
      <div className="hero">
        <p className="eyebrow">EVIDENCE LAYER · 口碑数据</p>
        <h1>让行程有据可依，<em>而不只靠模型想象</em></h1>
        <p className="hero-sub">
          手动录入、CSV 导入或授权通道接入的评分，会在生成规划时作为证据注入；缺失的数据源一律显示「未获取」，不会由模型补分。
        </p>
      </div>

      {error && <div className="error">{error}</div>}
      {notice && <div className="success">{notice}</div>}

      <div className="card">
        <div className="card-head">
          <h2>数据源状态</h2>
          <span className="card-index">01 / 来源</span>
        </div>
        <p className="sub">官方源需取得授权后在服务端 .env 配置；遇风控会熔断并降级为回源链接，不做任何绕过。</p>
        <p className="hint">出网通道：{proxy || '检测中…'}</p>
        <div className="ev-scroll">
          <table className="ev-table">
            <thead>
              <tr>
                <th>来源</th>
                <th>状态</th>
                <th>留存条款</th>
                <th>说明</th>
                <th>回源</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <tr key={source.id}>
                  <td>{source.label}</td>
                  <td>
                    <span className={`ev-state ${source.state}`}>{STATE_LABEL[source.state]}</span>
                  </td>
                  <td className="ev-rule">{source.cacheRule}</td>
                  <td className="ev-rule">{source.reason}</td>
                  <td>
                    {source.deepLink ? (
                      <a href={source.deepLink} target="_blank" rel="noopener noreferrer">
                        查看
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
              {sources.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">正在读取数据源状态…</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>对比矩阵预览</h2>
          <span className="card-index">02 / 对比</span>
        </div>
        <p className="sub">输入地点名（多个用逗号分隔），查看本地已有证据与各源状态。</p>
        <div className="row">
          <div className="field">
            <label htmlFor="preview-poi">地点</label>
            <input
              id="preview-poi"
              value={previewPoi}
              onChange={(e) => setPreviewPoi(e.target.value)}
              placeholder="例如：宽窄巷子, 成都大熊猫繁育研究基地"
            />
          </div>
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                /* refresh 在 run 内部按 previewPoi 执行 */
              }, '矩阵已刷新')
            }
          >
            查询
          </button>
        </div>
      </div>

      <EvidenceMatrix bundle={matrix} />

      <div className="card">
        <div className="card-head">
          <h2>手动录入一条证据</h2>
          <span className="card-index">03 / 录入</span>
        </div>
        <p className="sub">评分统一换算到 0–5；原始值保留用于对比。手动录入的数据标记为「低可信」，不会被当成平台官方评分。</p>
        <div className="ev-form">
          <div className="field">
            <label htmlFor="ev-poi">地点名称</label>
            <input id="ev-poi" value={draft.poiName} onChange={(e) => setField('poiName', e.target.value)} placeholder="例如：宽窄巷子" />
          </div>
          <div className="field">
            <label htmlFor="ev-source">来源</label>
            <select id="ev-source" value={draft.source} onChange={(e) => setField('source', e.target.value as EvidenceSource)}>
              {EVIDENCE_SOURCES.map((source) => (
                <option key={source} value={source}>
                  {EVIDENCE_SOURCE_LABELS[source]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ev-rating">归一化评分（0–5）</label>
            <input id="ev-rating" type="number" step="0.1" min="0" max="5" value={draft.rating} onChange={(e) => setField('rating', e.target.value)} placeholder="4.5" />
          </div>
          <div className="field">
            <label htmlFor="ev-raw">原始值</label>
            <input id="ev-raw" value={draft.ratingRaw} onChange={(e) => setField('ratingRaw', e.target.value)} placeholder="4.5/5 或 8.9/10" />
          </div>
          <div className="field">
            <label htmlFor="ev-scale">原始满分</label>
            <input id="ev-scale" type="number" step="1" min="1" value={draft.ratingScale} onChange={(e) => setField('ratingScale', e.target.value)} placeholder="5 或 10" />
          </div>
          <div className="field">
            <label htmlFor="ev-count">评价数</label>
            <input id="ev-count" type="number" min="0" value={draft.reviewCount} onChange={(e) => setField('reviewCount', e.target.value)} placeholder="12830" />
          </div>
          <div className="field ev-wide">
            <label htmlFor="ev-url">回源链接（http/https）</label>
            <input id="ev-url" value={draft.url} onChange={(e) => setField('url', e.target.value)} placeholder="https://…" />
          </div>
          <div className="field ev-wide">
            <label htmlFor="ev-snippet">备注</label>
            <input id="ev-snippet" value={draft.snippet} onChange={(e) => setField('snippet', e.target.value)} placeholder="例如：节假日人流较大" />
          </div>
        </div>
        <button className="btn primary" disabled={busy} onClick={submitDraft}>
          保存证据
        </button>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>CSV 批量导入</h2>
          <span className="card-index">04 / 导入</span>
        </div>
        <p className="sub">列名：poiName, source, rating, ratingRaw, ratingScale, reviewCount, url, snippet；source 取值见上方来源列表。</p>
        <div className="field">
          <label htmlFor="ev-csv">CSV 内容</label>
          <textarea id="ev-csv" value={csv} onChange={(e) => setCsv(e.target.value)} placeholder="粘贴 CSV 内容，或点下方按钮填入模板" />
        </div>
        <div className="row">
          <button className="btn" disabled={!csvTemplate} onClick={() => setCsv(csvTemplate)}>填入模板</button>
          <button
            className="btn primary"
            disabled={busy || !csv.trim()}
            onClick={() => void run(async () => {
              await api.importEvidence(csv)
              setCsv('')
            }, '导入完成，可在下方「已保存的证据」中查看')}
          >
            导入
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>已保存的证据</h2>
          <span className="card-index">05 / 记录</span>
        </div>
        <p className="sub">按账号隔离；删除后下一次生成规划不再使用该条数据。</p>
        <div className="ev-scroll">
          <table className="ev-table">
            <thead>
              <tr>
                <th>地点</th>
                <th>来源</th>
                <th>评分</th>
                <th>评价数</th>
                <th>可信度</th>
                <th>获取日期</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{item.poiName}</td>
                  <td>{EVIDENCE_SOURCE_LABELS[item.source]}</td>
                  <td>{item.rating === null ? '—' : `${item.rating.toFixed(1)} / 5`}</td>
                  <td>{item.reviewCount ?? '—'}</td>
                  <td>{item.confidence === 'high' ? '高' : item.confidence === 'medium' ? '中' : '低'}</td>
                  <td>{item.fetchedAt.slice(0, 10)}</td>
                  <td>
                    <button
                      className="btn small danger"
                      disabled={busy}
                      onClick={() => void run(async () => {
                        await api.deleteEvidence(item.id)
                      }, '已删除')}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted">暂无证据，先手动录入或导入 CSV。</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>小红书笔记检索</h2>
          <span className="card-index">06 / 笔记</span>
        </div>
        <p className="sub">按关键词查询笔记的标题、作者与互动数。结果仅用于检索展示，不产生评分、不落库、不注入指南生成。</p>
        <p className="hint">
          通道状态：{xhsStatus ? (xhsStatus.ready ? '已就绪' : '未就绪') : '检测中…'}
          {xhsStatus ? ` · ${xhsStatus.reason}` : ''}
        </p>
        {xhsStatus && <p className="hint xhs-compliance">{xhsStatus.compliance}</p>}
        <div className="row xhs-search-row">
          <div className="field">
            <label htmlFor="xhs-keyword">关键词</label>
            <input
              id="xhs-keyword"
              value={xhsKeyword}
              onChange={(e) => setXhsKeyword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') searchXhs() }}
              placeholder="例如：成都 宽窄巷子 攻略"
            />
          </div>
          <div className="field xhs-limit">
            <label htmlFor="xhs-limit">条数</label>
            <select id="xhs-limit" value={xhsLimit} onChange={(e) => setXhsLimit(e.target.value)}>
              <option value="5">5</option>
              <option value="8">8</option>
              <option value="12">12</option>
              <option value="20">20</option>
            </select>
          </div>
          <button className="btn primary" disabled={xhsBusy} onClick={searchXhs}>
            {xhsBusy ? '检索中…' : '查询笔记'}
          </button>
          <a
            className="btn"
            href={xhsResult?.deepLink ?? xhsStatus?.deepLink ?? XHS_SEARCH_FALLBACK}
            target="_blank"
            rel="noopener noreferrer"
          >
            打开小红书搜索
          </a>
        </div>
        {xhsResult && (
          <div className="xhs-notes">
            <p className={`hint ${xhsResult.mode === 'live' ? '' : 'ev-warn'}`}>{xhsResult.notice}</p>
            {xhsResult.items.map((note) => (
              <div className="xhs-note" key={note.id}>
                <div className="xhs-note-main">
                  <a href={note.url} target="_blank" rel="noopener noreferrer">{note.title || '（无标题笔记）'}</a>
                  <span className="xhs-note-meta">
                    {note.author || '匿名作者'} · 赞 {formatCount(note.likes)} · 藏 {formatCount(note.collects)} · 评 {formatCount(note.comments)}
                  </span>
                </div>
                <button className="btn small" disabled={busy} onClick={() => saveNoteAsLead(note)}>存为线索</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>导入浏览器采集数据</h2>
          <span className="card-index">07 / 扩展</span>
        </div>
        <p className="sub">
          安装「行迹 · 小红书线索采集」扩展后，在你已登录的小红书页面采集笔记，导出 JSON 粘贴或上传到这里。
          平台只接收你主动提供的数据，不代抓、不存 Cookie。
        </p>
        <p className="hint xhs-compliance">
          扩展只读你当前浏览器已渲染的页面内容，不发送网络请求、不读取 Cookie、不绕过风控。导入内容仅作人工核对线索，
          <b>不产生评分、不自动注入指南生成</b>。请自行确认对采集内容的使用符合平台条款与版权要求。
        </p>
        <div className="field" style={{ marginTop: 12 }}>
          <label htmlFor="ext-json">粘贴扩展导出的 JSON</label>
          <textarea
            id="ext-json"
            rows={6}
            value={extJson}
            onChange={(e) => loadExtensionJson(e.target.value)}
            placeholder={'{\n  "schemaVersion": 1,\n  "items": [ ... ]\n}'}
            style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
          />
        </div>
        <div className="row" style={{ marginTop: 10, alignItems: 'center' }}>
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => onExtFile(e.target.files?.[0])}
            style={{ fontSize: 12, maxWidth: 260 }}
          />
          <button className="btn primary" disabled={extItems.length === 0 || busy} onClick={importExtensionItems}>
            {busy ? '导入中…' : `导入 ${extItems.length} 条线索`}
          </button>
        </div>
        {extNotice && <p className={`hint ${extItems.length ? 'success' : 'ev-warn'}`} style={{ marginTop: 10 }}>{extNotice}</p>}
        {extItems.length > 0 && (
          <div className="xhs-notes">
            {extItems.slice(0, 20).map((it, idx) => (
              <div className="xhs-note" key={it.link || idx}>
                <div className="xhs-note-main">
                  <a href={it.link} target="_blank" rel="noopener noreferrer">{it.title || '（无标题）'}</a>
                  <span className="xhs-note-meta">
                    {it.author || '匿名作者'}{it.likes !== null ? ` · 赞 ${formatCount(it.likes)}` : ''}
                    {it.summary ? ` · ${it.summary.slice(0, 40)}…` : ''}
                  </span>
                </div>
              </div>
            ))}
            {extItems.length > 20 && <p className="hint">仅显示前 20 条，导入将包含全部 {extItems.length} 条。</p>}
          </div>
        )}
      </div>
    </>
  )
}
