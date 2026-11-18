import { useEffect, useState } from 'react'
import type { GenerationEvent } from '../../../shared/types'

const STAGE_LABELS: Record<string, string> = {
  prepare: '准备',
  options: '候选方案',
  evidence: '口碑取证',
  geo: '地图定位',
  guide_meta: '指南概览',
  guide_days: '逐日行程',
  guide_spots: '地点图册',
  validate: '结构校验',
  done: '完成',
  error: '失败',
}

const MARKS: Record<GenerationEvent['type'], string> = {
  stage: '◈',
  progress: '✓',
  retry: '↻',
  log: '·',
  error: '×',
  done: '✓',
}

interface Props {
  events: GenerationEvent[]
  active: boolean
  startedAt: number | null
  failure: { message: string; detail?: string } | null
}

export default function GenerationPanel({ events, active, startedAt, failure }: Props) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 200)
    return () => clearInterval(timer)
  }, [active])

  const elapsed = active && startedAt ? (now - startedAt) / 1000 : (events.at(-1)?.elapsedMs ?? 0) / 1000
  const latest = [...events].reverse().find((event) => event.current !== undefined && event.total)
  const percent = failure ? 100 : !active ? 100 : latest?.total ? Math.round(((latest.current ?? 0) / latest.total) * 100) : 8
  const currentMessage = events.at(-1)?.message ?? '正在准备…'
  const status = failure ? 'error' : active ? 'running' : 'done'

  return (
    <section className={`run-panel run-${status}`}>
      <header className="run-head">
        <div className="run-status">
          <span className={`run-pulse${active ? ' live' : ''}`} />
          <span>{failure ? '生成失败' : active ? '正在生成' : '生成完成'}</span>
          <span className="run-stage-tag">{STAGE_LABELS[events.at(-1)?.stage ?? 'prepare'] ?? '准备'}</span>
        </div>
        <span className="run-timer">{elapsed.toFixed(1)}s</span>
      </header>

      <p className="run-current">{failure ? '任务已中止，下面是错误详情' : currentMessage}</p>
      <div className="run-track"><div className="run-fill" style={{ width: `${percent}%` }} /></div>
      <div className="run-meta">
        <span>{latest?.total ? `步骤 ${latest.current ?? 0} / ${latest.total}` : active ? '连接模型中' : '全部步骤完成'}</span>
        <span>{percent}%</span>
      </div>

      {failure && (
        <div className="run-failure">
          <strong>出了什么问题</strong>
          <p>{failure.message}</p>
          <p className="run-tip">
            常见原因：所选模型未开通、API Key 与端点不匹配、模型输出结构不完整。可先到「模型设置」测试连通，再回来重试。
          </p>
        </div>
      )}

      {events.length > 0 && (
        <div className="run-timeline">
          {events.map((event, index) => (
            <div className={`run-item run-item-${event.type}`} key={`${event.stage}-${index}`}>
              <span className="run-mark">{MARKS[event.type]}</span>
              <div className="run-body">
                <div className="run-line">
                  <span className="run-label">{STAGE_LABELS[event.stage] ?? event.stage}</span>
                  {event.attempt !== undefined && <span className="run-attempt">第 {event.attempt} 次</span>}
                  <time>{(event.elapsedMs / 1000).toFixed(1)}s</time>
                </div>
                <p>{event.message}</p>
                {event.detail && (
                  <details className="run-detail">
                    <summary>查看上游原文 / 出错片段</summary>
                    <pre>{event.detail}</pre>
                  </details>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
