import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, errorMessage } from '../api'
import type { PlanSummary } from '../../../shared/types'

interface Props {
  open: boolean
  onClose: () => void
  /** 打开某次提问（加载到向导对应步骤） */
  onOpenPlan: (planId: string) => void
  /** 直接在这份指南上继续优化 */
  onRefinePlan: (planId: string) => void
}

const fmt = (value: string): string =>
  new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })

/** 提问历史抽屉：每个账号的每次提问与后续版本都在这里，可回看或继续优化 */
export default function HistoryDrawer({ open, onClose, onOpenPlan, onRefinePlan }: Props) {
  const [items, setItems] = useState<PlanSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError('')
    api.planHistory()
      .then(setItems)
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false))
  }, [open])

  if (!open) return null

  // 渲染到 body：容器有 z-index 层叠上下文，普通定位会被顶栏盖住
  return createPortal(
    <div className="drawer-mask" onClick={onClose} role="presentation">
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <div>
            <p className="eyebrow">YOUR QUESTIONS</p>
            <h3>提问历史</h3>
          </div>
          <button className="btn ghost small" onClick={onClose}>关闭</button>
        </header>
        <p className="sub">每次提问都会留痕；「继续优化」会在原指南基础上生成新版本，旧版本仍可回看。</p>
        {loading && <p className="muted">正在读取…</p>}
        {error && <div className="error">{error}</div>}
        {!loading && !error && items.length === 0 && <p className="muted">还没有提问记录，先去「需求」填一句旅行想法吧。</p>}
        <ul className="history-list">
          {items.map((item) => (
            <li key={item.id} className="history-item">
              <div className="history-main">
                <div className="history-title">
                  {item.version > 1 && <span className="badge">第 {item.version} 版</span>}
                  <b>{item.title || item.requirement.slice(0, 28)}</b>
                </div>
                <p className="history-req">{item.requirement.slice(0, 80)}{item.requirement.length > 80 ? '…' : ''}</p>
                {item.revisionNote && <p className="history-note">优化要求：{item.revisionNote}</p>}
                <p className="history-meta">
                  {fmt(item.createdAt)}
                  {item.hasGuide ? '　·　指南已生成' : item.hasOptions ? '　·　仅候选方案' : ''}
                </p>
              </div>
              <div className="history-actions">
                <button className="btn small ghost" onClick={() => onOpenPlan(item.id)}>打开</button>
                {item.hasGuide && (
                  <button className="btn small" onClick={() => onRefinePlan(item.id)}>继续优化</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </aside>
    </div>,
    document.body,
  )
}
