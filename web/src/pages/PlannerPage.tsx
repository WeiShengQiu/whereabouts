import { useEffect, useState } from 'react'
import { api, downloadUrl, errorMessage, GenerationError } from '../api'
import GenerationPanel from '../components/GenerationPanel'
import EvidenceMatrix from '../components/EvidenceMatrix'
import ResearchPanel from '../components/ResearchPanel'
import {
  fallbackGeoPoi,
  matchGeoPoi,
  renderGeoStatus,
  renderRouteMap,
  renderSpotMapCard,
} from '../../../shared/geo-view'
import type { FileView, GenerationEvent, LLMConfigView, ModelInfo, PlanView } from '../../../shared/types'

type Busy = 'options' | 'select' | 'guide' | 'export' | null

interface RunState {
  active: boolean
  events: GenerationEvent[]
  startedAt: number | null
}
const EMPTY_RUN: RunState = { active: false, events: [], startedAt: null }

export default function PlannerPage() {
  const [configs, setConfigs] = useState<LLMConfigView[]>([])
  const [configId, setConfigId] = useState('')
  const [model, setModel] = useState('')
  const [models, setModels] = useState<ModelInfo[]>([])
  const [manualOnly, setManualOnly] = useState(false)
  const [modelReason, setModelReason] = useState('')
  const [requirement, setRequirement] = useState('')
  const [plan, setPlan] = useState<PlanView | null>(null)
  const [exported, setExported] = useState<FileView | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState('')
  const [run, setRun] = useState<RunState>(EMPTY_RUN)
  const [failure, setFailure] = useState<{ message: string; detail?: string } | null>(null)
  const [researchCount, setResearchCount] = useState(0)

  const loadModels = async (id: string, defaultModel: string) => {
    try {
      const result = await api.models(id)
      setModels(result.models)
      setManualOnly(result.manualOnly)
      // 不替用户猜模型：/models 常返回平台全量目录，首个模型未必在该账号下已开通
      setModel(defaultModel)
      setModelReason(
        [
          result.reason,
          result.models.length > 0
            ? '列表由服务端返回，不保证每个模型都已开通；若调用报 400，请改填该账号已开通的模型名'
            : '',
        ].filter(Boolean).join('；'),
      )
    } catch (e) {
      setModels([])
      setManualOnly(true)
      setModelReason(errorMessage(e))
      setModel(defaultModel)
    }
  }

  useEffect(() => {
    api.configs()
      .then((list) => {
        setConfigs(list)
        if (list.length) {
          setConfigId(list[0].id)
          void loadModels(list[0].id, list[0].defaultModel)
        } else {
          setManualOnly(true)
          setModelReason('尚未配置模型服务，请先到「模型设置」新增一个配置')
        }
      })
      .catch((e) => setError(errorMessage(e)))
  }, [])

  const onConfigChange = (id: string) => {
    setConfigId(id)
    const target = configs.find((item) => item.id === id)
    void loadModels(id, target?.defaultModel ?? '')
  }

  /** 两阶段生成统一走 SSE：逐条收事件、渲染任务面板，失败时保留上游原文 */
  const runTask = async (
    task: (onEvent: (event: GenerationEvent) => void) => Promise<PlanView>,
    apply: (result: PlanView) => void,
    busyKey: Busy,
  ) => {
    setBusy(busyKey)
    setError('')
    setFailure(null)
    setRun({ active: true, events: [], startedAt: Date.now() })
    try {
      const result = await task((event) => setRun((prev) => ({ ...prev, events: [...prev.events, event] })))
      apply(result)
    } catch (e) {
      const err = e instanceof GenerationError ? e : new GenerationError(errorMessage(e))
      setFailure({ message: err.message, detail: err.detail })
      setError(err.message)
    } finally {
      setRun((prev) => ({ ...prev, active: false }))
      setBusy(null)
    }
  }

  const createOptions = async () => {
    // configId / model 留空时由后端回退到系统内置默认模型，前端不再硬拦
    if (requirement.trim().length < 5) return setError('请多描述一点旅行需求（至少 5 个字）')
    setPlan(null)
    setExported(null)
    await runTask(
      (onEvent) => api.createPlanStream(requirement.trim(), configId, model.trim(), onEvent),
      (result) => setPlan(result),
      'options',
    )
  }

  const choose = async (index: number) => {
    if (!plan) return
    setBusy('select')
    setError('')
    try {
      setPlan(await api.selectOption(plan.id, index))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const generateGuide = async () => {
    if (!plan) return
    setExported(null)
    await runTask(
      (onEvent) => api.generateGuideStream(plan.id, onEvent),
      (result) => setPlan(result),
      'guide',
    )
  }

  const exportHtml = async () => {
    if (!plan) return
    setBusy('export')
    setError('')
    try {
      setExported(await api.exportHtml(plan.id))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  // 实采是可选步骤：真实阶段 1需求/2挑选/3指南/4导出 映射到 5 格步骤条（实采恒为可做）
  const realStep = !plan ? 1 : plan.selectedIndex === null ? 2 : !plan.guide ? 3 : 4
  const step = realStep + (realStep >= 2 ? 1 : 0)
  // 历史指南没有 spots 字段，前端按缺省空数组处理
  const spots = plan?.guide?.spots ?? []

  return (
    <>
      <div className="hero">
        <p className="eyebrow">CURATED JOURNEYS · 行迹</p>
        <h1>把想去的地方，<em>交给一份真正懂你的指南</em></h1>
        <p className="hero-sub">说出你的旅行想法，AI 生成差异化方案；选定方向后，再打磨成一份可执行的完整行程。</p>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>说说你想怎么玩</h2>
          <span className="card-index">01 / 需求</span>
        </div>
        <p className="sub">先生成几个差异化方案，选定一个后再优化成完整指南</p>
        <div className="row">
          <div className="field">
            <label htmlFor="config">模型配置</label>
            <select id="config" value={configId} onChange={(e) => onConfigChange(e.target.value)}>
              {configs.length === 0 && <option value="">暂无配置</option>}
              {configs.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="model">本次使用的模型</label>
            {manualOnly || models.length === 0 ? (
              <input id="model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="例如 qwen-plus / gpt-4o-mini" />
            ) : (
              <select id="model" value={model} onChange={(e) => setModel(e.target.value)}>
                {!models.some((item) => item.id === model) && <option value={model}>{model || '请选择模型'}</option>}
                {models.map((item) => <option key={item.id} value={item.id}>{item.id}{item.ownedBy ? ` · ${item.ownedBy}` : ''}</option>)}
              </select>
            )}
          </div>
          <button className="btn" disabled={!configId || busy !== null} onClick={() => void loadModels(configId, '')}>刷新模型</button>
        </div>
        {modelReason && <p className="hint">{modelReason}</p>}
        <div className="sep" />
        <div className="field">
          <label htmlFor="requirement">旅行需求</label>
          <textarea
            id="requirement"
            value={requirement}
            onChange={(e) => setRequirement(e.target.value)}
            placeholder="例如：11 月中旬和伴侣去成都及周边 4 天，预算 5000 元以内，喜欢小众街区和本地小吃，不想赶行程"
          />
        </div>
        <button className="btn primary" onClick={() => void createOptions()} disabled={busy !== null}>
          {busy === 'options' ? '正在生成候选方案…' : '生成定制方案'}
        </button>
        {researchCount > 0 && (
          <p className="hint">本次将结合你采集的 {researchCount} 条小红书线索生成方案（仅作地点与玩法参考）。</p>
        )}
        {error && run.events.length === 0 && <div className="error">{error}</div>}
      </div>

      <ResearchPanel
        requirement={requirement}
        configId={configId}
        model={model}
        onCountChange={setResearchCount}
      />

      {(run.active || run.events.length > 0) && (
        <GenerationPanel events={run.events} active={run.active} startedAt={run.startedAt} failure={failure} />
      )}

      <div className="steps">
        {['描述需求', '小红书实采(可选)', '挑选方案', '生成指南', '导出 HTML'].map((label, index) => (
          <span className={step === index + 1 ? 'on' : step > index + 1 ? 'passed' : ''} key={label}>
            <b>0{index + 1}</b>{label}
          </span>
        ))}
      </div>

      {plan?.options && (
        <div className="card">
          <div className="card-head">
            <h2>挑一个方向</h2>
            <span className="card-index">02 / 选择</span>
          </div>
          <p className="sub">点击卡片选定，随后可以据此生成完整指南</p>
          <div className="option-grid">
            {plan.options.map((option, index) => (
              <div
                key={`${option.title}-${index}`}
                className={`option${plan.selectedIndex === index ? ' selected' : ''}`}
                onClick={() => void choose(index)}
              >
                <span className="option-num">0{index + 1}</span>
                <h3>{option.title}</h3>
                <span className="badge">{option.theme}</span>
                <div className="kv"><b>{option.days}</b> · {option.pace}</div>
                <div className="kv">预算 <b>{option.budget}</b></div>
                <p>{option.summary}</p>
                <p className="kv">亮点：{option.highlights.join(' / ')}</p>
                <p className="kv">适合：{option.suitableFor}</p>
              </div>
            ))}
          </div>
          {busy === 'select' && <p className="hint">正在保存选择…</p>}
        </div>
      )}

      {plan?.options && <EvidenceMatrix bundle={plan.evidence} />}

      {plan && plan.selectedIndex !== null && !plan.guide && (
        <div className="card">
          <div className="card-head">
            <h2>生成完整指南</h2>
            <span className="card-index">03 / 打磨</span>
          </div>
          <p className="sub">分块输出详细每日行程、地点图文卡、预算与行前清单；地图定位与口碑数据由系统取证后注入</p>
          <button className="btn primary" onClick={() => void generateGuide()} disabled={busy !== null}>
            {busy === 'guide' ? '正在优化生成指南…' : '生成旅游指南'}
          </button>
        </div>
      )}

      {plan?.guide && (
        <div className="card">
          <div className="guide-hero">
            <p className="eyebrow">YOUR TRAVEL GUIDE · 定制指南</p>
            <h2>{plan.guide.title}</h2>
            <p className="muted">{plan.guide.destination}　·　{plan.guide.duration}</p>
          </div>
          <div className="guide-overview">{plan.guide.overview}</div>
          {spots.length > 0 && (
            <>
              <div className="sep" />
              <h3 className="section-title">行程总览</h3>
              <div dangerouslySetInnerHTML={{ __html: renderRouteMap(spots, plan.geo) }} />
              <div dangerouslySetInnerHTML={{ __html: renderGeoStatus(plan.geo) }} />
            </>
          )}
          <div className="sep" />
          <h3 className="section-title">每日行程</h3>
          <div className="day-list">
            {plan.guide.days.map((day, index) => (
              <div className="day" key={`${day.day}-${index}`}>
                <h3><span className="day-no">D{index + 1}</span>{day.day} · {day.title}</h3>
                <dl>
                  <div><dt>上午</dt><dd>{day.morning}</dd></div>
                  <div><dt>下午</dt><dd>{day.afternoon}</dd></div>
                  <div><dt>晚上</dt><dd>{day.evening}</dd></div>
                  <div><dt>餐饮</dt><dd>{day.meals}</dd></div>
                  <div><dt>交通</dt><dd>{day.transport}</dd></div>
                  <div><dt>贴士</dt><dd>{day.tips}</dd></div>
                </dl>
              </div>
            ))}
          </div>
          <div className="sep" />
          <h3 className="section-title">地点图册 · 图文详解</h3>
          {spots.length === 0 ? (
            <p className="muted">本指南未包含地点图册（历史记录或模型未返回图册数据）。</p>
          ) : (
            <div className="spot-grid">
              {spots.map((spot, index) => {
                const poi = matchGeoPoi(plan.geo, spot.name) ?? fallbackGeoPoi(spot.name, plan.geo?.city ?? '')
                return (
                  <article className="spot" key={`spot-${index}`}>
                    <div dangerouslySetInnerHTML={{ __html: renderSpotMapCard(poi, index) }} />
                    <div className="spot-body">
                      <div className="spot-tags">
                        <span>{spot.category}</span><span>{spot.day} {spot.time}</span>
                        <span>停留 {spot.stay}</span><span>{spot.cost}</span>
                      </div>
                      <p className="spot-intro">{spot.intro}</p>
                      {spot.highlights.length > 0 && (
                        <ul className="spot-list">{spot.highlights.map((item, i) => <li key={`h-${i}`}>{item}</li>)}</ul>
                      )}
                      <p className="spot-extra"><b>贴士</b>{spot.tips}</p>
                      <p className="spot-extra"><b>取景</b>{spot.photo}</p>
                    </div>
                  </article>
                )
              })}
            </div>
          )}
          <div className="sep" />
          <h3 className="section-title">预算参考</h3>
          <p><span className="pill">{plan.guide.budget.level}</span><span className="pill">合计 {plan.guide.budget.total}</span></p>
          {plan.guide.budget.items.map((item, index) => <span className="pill" key={`budget-${index}`}>{item}</span>)}
          <div className="sep" />
          <div className="grid-2">
            <div><h3 className="section-title">行前清单</h3>{plan.guide.packing.map((item, index) => <p className="muted" key={`packing-${index}`}>· {item}</p>)}</div>
            <div><h3 className="section-title">注意事项</h3>{plan.guide.notes.map((item, index) => <p className="muted" key={`note-${index}`}>· {item}</p>)}</div>
          </div>
          <div className="sep" />
          <p className="sub">导出的单文件 HTML 内含完整图文卡、定位深链与口碑来源表，可直接打印为 PDF；若已开启地图 Key，会内嵌官方静态地图截图。</p>
          <button className="btn primary" onClick={() => void exportHtml()} disabled={busy !== null}>
            {busy === 'export' ? '正在生成 HTML…' : '导出 HTML 指南'}
          </button>
          {exported && (
            <div className="success">
              <span>已生成并记录（{(exported.sizeBytes / 1024).toFixed(1)} KB）</span>
              <a className="btn small" href={downloadUrl(exported.id)} download>下载 HTML</a>
            </div>
          )}
        </div>
      )}
    </>
  )
}
