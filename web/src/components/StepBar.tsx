interface Props {
  steps: string[]
  /** 当前步骤，从 1 开始 */
  current: number
  /** 已经走到过的最远步骤，超过的部分不允许跳转 */
  maxStep: number
  onJump: (step: number) => void
  onOpenHistory: () => void
  onReset: () => void
  historyCount: number
  /** 生成任务进行中的提示（进度条下方一行小字） */
  status?: string
}

/**
 * 常驻步骤条：吸顶显示，显示当前步骤与完成情况，避免用户上下来回滑动找进度。
 * 只允许跳回已经走过的步骤，未解锁的步骤不可点。
 */
export default function StepBar({ steps, current, maxStep, onJump, onOpenHistory, onReset, historyCount, status }: Props) {
  return (
    <div className="stepbar">
      <ol className="stepbar-track">
        {steps.map((label, index) => {
          const step = index + 1
          const state = step === current ? 'on' : step < current || step <= maxStep ? 'passed' : 'locked'
          return (
            <li key={label} className={state}>
              <button
                type="button"
                onClick={() => step <= maxStep && onJump(step)}
                disabled={step > maxStep}
                aria-current={step === current ? 'step' : undefined}
              >
                <b>{String(step).padStart(2, '0')}</b>
                <span>{label}</span>
              </button>
            </li>
          )
        })}
      </ol>
      <div className="stepbar-actions">
        <button className="btn ghost small" onClick={onOpenHistory}>
          提问历史{historyCount > 0 ? ` · ${historyCount}` : ''}
        </button>
        <button className="btn ghost small" onClick={onReset}>重新开始</button>
      </div>
      {status && <p className="stepbar-status">{status}</p>}
    </div>
  )
}
