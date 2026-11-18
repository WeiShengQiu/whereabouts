import { useCallback, useEffect, useRef, useState } from 'react'
import { api, downloadUrl, errorMessage, GenerationError } from '../api'
import GenerationPanel from '../components/GenerationPanel'
import GuideView from '../components/GuideView'
import HistoryDrawer from '../components/HistoryDrawer'
import ResearchPanel from '../components/ResearchPanel'
import StepBar from '../components/StepBar'
import { runAutoResearch } from '../xhsBridge'
import type { FileView, GenerationEvent, LLMConfigView, ModelInfo, PlanView } from '../../../shared/types'

type Busy = 'options' | 'select' | 'guide' | 'refine' | 'export' | null
type Step = 1 | 2 | 3 | 4

const STEP_LABELS = ['描述需求', '挑选方案', '生成指南', '导出 HTML']
/** 常用优化要求：一键填入，避免每次手打 */
const REFINE_PRESETS = ['节奏再慢一点，每天少排一个点', '改成亲子友好，减少步行', '预算压低 20%', '多安排本地小吃，少去商业街区']

interface RunState {
  active: boolean
  events: GenerationEvent[]
  startedAt: number | null
}
const EMPTY_RUN: RunState = { active: false, events: [], startedAt: null }

const scrollTop = () => window.scrollTo({ top: 0, behavior: 'smooth' })

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
  const [researchTotal, setResearchTotal] = useState(0)
  /** 实采默认自动：用户填完需求点生成即可，扩展+登录只需要在首次准备一次 */
  const [autoResearchEnabled, setAutoResearchEnabled] = useState(true)
  const [autoBusy, setAutoBusy] = useState(false)
  const [autoNotice, setAutoNotice] = useState('')

  const [step, setStep] = useState<Step>(1)
  const [maxStep, setMaxStep] = useState<Step>(1)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyCount, setHistoryCount] = useState(0)
  const [refineText, setRefineText] = useState('')
  const [refineNotice, setRefineNotice] = useState('')
  const refineRef = useRef<HTMLTextAreaElement | null>(null)

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

  const refreshHistoryCount = useCallback(() => {
    api.planHistory()
      .then((list) => setHistoryCount(list.length))
      .catch(() => { /* 历史条数读取失败不影响主流程 */ })
  }, [])

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
    refreshHistoryCount()
  }, [refreshHistoryCount])

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

  const goStep = (next: Step) => {
    setStep(next)
    scrollTop()
  }

  const createOptions = async () => {
    // configId / model 留空时由后端回退到系统内置默认模型，前端不再硬拦
    if (requirement.trim().length < 5) return setError('请多描述一点旅行需求（至少 5 个字）')
    setPlan(null)
    setExported(null)
    setRefineNotice('')

    // 自动实采：拆词 → 扩展采集（30–50 条）→ 后端按批次导入 → 随方案快照注入模型。失败只降级、不阻断生成。
    let collectedRunId = ''
    if (autoResearchEnabled) {
      setAutoBusy(true)
      setAutoNotice('')
      try {
        const result = await runAutoResearch(requirement.trim(), configId, model.trim())
        setAutoNotice(result.message)
        collectedRunId = result.runId ?? ''
      } catch (e) {
        setAutoNotice(`自动采集跳过：${errorMessage(e)}`)
      } finally {
        setAutoBusy(false)
      }
    }

    await runTask(
      (onEvent) => api.createPlanStream(requirement.trim(), configId, model.trim(), onEvent, collectedRunId),
      (result) => {
        setPlan(result)
        setMaxStep(2)
        goStep(2)
      },
      'options',
    )
  }

  const choose = async (index: number) => {
    if (!plan) return
    // 点了同一个方案：直接前进，不要让后端清空已经生成的指南
    if (plan.selectedIndex === index) {
      setMaxStep((prev) => (prev < 3 ? 3 : prev))
      goStep(3)
      return
    }
    // 换方案会让后端丢弃旧指南，必须先明确告知再执行
    if (plan.guide && !window.confirm('换一个方案会清空当前的指南，需要重新生成。确定要换吗？')) return
    setBusy('select')
    setError('')
    try {
      setPlan(await api.selectOption(plan.id, index))
      setMaxStep((prev) => (prev < 3 ? 3 : prev))
      goStep(3)
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
      (result) => {
        setPlan(result)
        setMaxStep(4)
        scrollTop()
      },
      'guide',
    )
  }

  /** 继续优化：以当前指南为基线生成新一版，旧版本保留在提问历史里 */
  const refine = async (instruction?: string) => {
    if (!plan) return
    const text = (instruction ?? refineText).trim()
    if (text.length < 2) return setError('请写一句具体的优化要求，例如「第三天改成亲子向，减少步行」')
    setExported(null)
    setRefineNotice('')
    await runTask(
      (onEvent) => api.refinePlanStream(plan.id, text, onEvent),
      (result) => {
        setPlan(result)
        setMaxStep(4)
        setRefineText('')
        setStep(3)
        setRefineNotice(`已按「${text}」生成第 ${result.version} 版，上一版仍在提问历史里。`)
        refreshHistoryCount()
        scrollTop()
      },
      'refine',
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

  /** 打开历史提问：恢复到对应步骤，需求与方案一起带回向导 */
  const openPlan = async (id: string) => {
    setError('')
    try {
      const loaded = await api.plan(id)
      setPlan(loaded)
      setRequirement(loaded.requirement)
      setExported(null)
      setRefineNotice('')
      const target: Step = loaded.guide ? 3 : loaded.selectedIndex !== null ? 3 : 2
      // 有指南的历史提问可以直接跳到「导出」，不用再逐步解锁
      const reachable: Step = loaded.guide ? 4 : target
      setMaxStep((prev) => (prev > reachable ? prev : reachable))
      setHistoryOpen(false)
      goStep(target)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const refineFromHistory = async (id: string) => {
    await openPlan(id)
    setHistoryOpen(false)
    setTimeout(() => refineRef.current?.focus(), 220)
  }

  const reset = () => {
    setPlan(null)
    setExported(null)
    setError('')
    setFailure(null)
    setRun(EMPTY_RUN)
    setRefineText('')
    setRefineNotice('')
    setMaxStep(1)
    goStep(1)
  }

  const spots = plan?.guide?.spots ?? []
  const status = run.active
    ? run.events[run.events.length - 1]?.message ?? '正在生成…'
    : autoBusy
      ? '正在自动采集小红书线索…'
      : autoNotice

  return (
    <>
      <StepBar
        steps={STEP_LABELS}
        current={step}
        maxStep={maxStep}
        onJump={(target) => goStep(target as Step)}
        onOpenHistory={() => setHistoryOpen(true)}
        onReset={reset}
        historyCount={historyCount}
        status={status || undefined}
      />

      <div id="wizard-top" />

      {/* 生成任务面板常驻在步骤条下方：不随步骤切换而移动，方便随时看进度 */}
      {(run.active || run.events.length > 0) && (
        <GenerationPanel events={run.events} active={run.active} startedAt={run.startedAt} failure={failure} />
      )}

      {step === 1 && (
        <>
          <div className="hero compact">
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
            <label className="auto-toggle">
              <input
                type="checkbox"
                checked={autoResearchEnabled}
                onChange={(e) => setAutoResearchEnabled(e.target.checked)}
                disabled={busy !== null || autoBusy}
              />
              自动采集小红书线索（30–50 条，需装扩展并登录一次）
            </label>
            <button className="btn primary" onClick={() => void createOptions()} disabled={busy !== null || autoBusy}>
              {autoBusy ? '正在自动采集小红书线索…' : busy === 'options' ? '正在生成候选方案…' : '生成定制方案'}
            </button>
            {autoNotice && <p className="hint">{autoNotice}</p>}
            {researchTotal > 0 && (
              <p className="hint">本账号保留最近三次提问的 {researchTotal} 条线索，生成时按本次提问取用（仅作参考，非评分）。</p>
            )}
            {error && run.events.length === 0 && <div className="error">{error}</div>}
          </div>

          <ResearchPanel
            requirement={requirement}
            configId={configId}
            model={model}
            onTotalChange={setResearchTotal}
          />
        </>
      )}

      {step === 2 && (
        <div className="card">
          <div className="card-head">
            <h2>挑一个方向</h2>
            <span className="card-index">02 / 选择</span>
          </div>
          <p className="sub">点击卡片即选定并进入下一步；之后随时可以退回这里重选</p>
          {!plan?.options ? (
            <p className="muted">还没有候选方案，请先回到「描述需求」生成。</p>
          ) : (
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
          )}
          {busy === 'select' && <p className="hint">正在保存选择…</p>}
          <div className="step-nav">
            <button className="btn ghost" onClick={() => goStep(1)}>← 返回需求</button>
            {plan && plan.selectedIndex !== null && (
              <button className="btn" onClick={() => goStep(3)}>下一步：生成指南 →</button>
            )}
          </div>
        </div>
      )}

      {step === 3 && (
        <>
          {!plan ? (
            <div className="card">
              <p className="muted">还没有选中方案，请先回到「挑选方案」。</p>
              <div className="step-nav"><button className="btn ghost" onClick={() => goStep(2)}>← 返回方案</button></div>
            </div>
          ) : !plan.guide ? (
            <div className="card">
              <div className="card-head">
                <h2>生成完整指南</h2>
                <span className="card-index">03 / 打磨</span>
              </div>
              <p className="sub">分块输出每日行程、地点图文卡与真实小红书笔记；地图只提供官方定位链接，不编造评分</p>
              <button className="btn primary" onClick={() => void generateGuide()} disabled={busy !== null}>
                {busy === 'guide' ? '正在优化生成指南…' : '生成旅游指南'}
              </button>
              <div className="step-nav">
                <button className="btn ghost" onClick={() => goStep(2)}>← 返回方案</button>
              </div>
            </div>
          ) : (
            <>
              <div className="card">
                <GuideView plan={plan} />
                {plan.research?.items.length ? (
                  <p className="hint">本版参考了 {plan.research.items.length} 条小红书实采线索；笔记卡片为实采佐证，非评分。</p>
                ) : null}
                <div className="step-nav">
                  <button className="btn ghost" onClick={() => goStep(2)}>← 返回方案</button>
                  <button className="btn primary" onClick={() => goStep(4)}>下一步：导出 →</button>
                </div>
              </div>

              <div className="card refine-card">
                <div className="card-head">
                  <h2>继续优化这一版</h2>
                  <span className="card-index">迭代</span>
                </div>
                <p className="sub">
                  当前是第 {plan.version} 版。写下要改的地方，系统会以这一版为基线生成新版本，旧版本保留在提问历史里。
                </p>
                <div className="refine-presets">
                  {REFINE_PRESETS.map((preset) => (
                    <button key={preset} className="pill-btn" onClick={() => void refine(preset)} disabled={busy !== null}>
                      {preset}
                    </button>
                  ))}
                </div>
                <div className="field" style={{ marginTop: 14 }}>
                  <label htmlFor="refine">优化要求</label>
                  <textarea
                    id="refine"
                    ref={refineRef}
                    value={refineText}
                    onChange={(e) => setRefineText(e.target.value)}
                    placeholder="例如：第三天太赶了，改成上午只去一个地方，下午留出咖啡时间；预算压到 4000 以内"
                  />
                </div>
                <button className="btn primary" onClick={() => void refine()} disabled={busy !== null}>
                  {busy === 'refine' ? '正在按新要求改写…' : '生成新版本'}
                </button>
                {refineNotice && <p className="hint success-text">{refineNotice}</p>}
                {plan.parentPlanId && <p className="hint">本版基于上一版指南修改而来，可随时在提问历史中回看上一版。</p>}
              </div>
            </>
          )}
        </>
      )}

      {step === 4 && (
        <div className="card">
          <div className="card-head">
            <h2>导出 HTML 指南</h2>
            <span className="card-index">04 / 导出</span>
          </div>
          <p className="sub">
            单文件 HTML 内含完整图文卡、真实小红书笔记与地图深链，可直接打印为 PDF；
            仅在拿到官方静态地图截图时才内嵌图片，否则只保留定位链接。
          </p>
          {!plan?.guide ? (
            <>
              <p className="muted">还没有生成指南，先回到上一步生成。</p>
              <div className="step-nav"><button className="btn ghost" onClick={() => goStep(3)}>← 返回指南</button></div>
            </>
          ) : (
            <>
              <div className="export-summary">
                <div><span>指南</span><b>{plan.guide.title}</b></div>
                <div><span>版本</span><b>第 {plan.version} 版</b></div>
                <div><span>地点</span><b>{spots.length} 个</b></div>
                <div><span>线索</span><b>{plan.research?.items.length ?? 0} 条</b></div>
              </div>
              <div className="step-nav">
                <button className="btn ghost" onClick={() => goStep(3)}>← 返回指南</button>
                <button className="btn primary" onClick={() => void exportHtml()} disabled={busy !== null}>
                  {busy === 'export' ? '正在生成 HTML…' : '导出 HTML 指南'}
                </button>
              </div>
              {exported && (
                <div className="success">
                  <span>已生成并记录（{(exported.sizeBytes / 1024).toFixed(1)} KB）</span>
                  <a className="btn small" href={downloadUrl(exported.id)} download>下载 HTML</a>
                </div>
              )}
              {error && <div className="error">{error}</div>}
            </>
          )}
        </div>
      )}

      <HistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onOpenPlan={(id) => void openPlan(id)}
        onRefinePlan={(id) => void refineFromHistory(id)}
      />
    </>
  )
}
