import { useEffect, useState } from 'react'
import { api, downloadUrl, errorMessage } from '../api'
import type { FileView, PlanView, SessionView } from '../../../shared/types'

function fmt(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
}

export default function HistoryPage() {
  const [plans, setPlans] = useState<PlanView[]>([])
  const [sessions, setSessions] = useState<SessionView[]>([])
  const [files, setFiles] = useState<FileView[]>([])
  const [plansError, setPlansError] = useState('')
  const [sessionsError, setSessionsError] = useState('')
  const [filesError, setFilesError] = useState('')

  useEffect(() => {
    api.plans().then(setPlans).catch((e) => setPlansError(errorMessage(e)))
    api.sessions().then(setSessions).catch((e) => setSessionsError(errorMessage(e)))
    api.files().then(setFiles).catch((e) => setFilesError(errorMessage(e)))
  }, [])

  return (
    <>
      <div className="hero">
        <p className="eyebrow">YOUR ARCHIVE · 我的记录</p>
        <h1>每一段旅程，<em>都有迹可循</em></h1>
        <p className="hero-sub">文件、规划与登录会话按账号留存，随时回看或重新下载。</p>
      </div>
      <div className="card">
        <div className="card-head">
          <h2>文件生成记录</h2>
          <span className="card-index">01 / 文件</span>
        </div>
        <p className="sub">每次导出的 HTML 指南都会留痕，可随时重新下载</p>
        {filesError && <div className="error">{filesError}</div>}
        {files.length === 0 && !filesError ? (
          <p className="muted">还没有导出过文件</p>
        ) : (
          <table>
            <thead><tr><th>生成时间</th><th>类型</th><th>大小</th><th>文件</th><th>操作</th></tr></thead>
            <tbody>
              {files.map((file) => (
                <tr key={file.id}>
                  <td>{fmt(file.createdAt)}</td>
                  <td>{file.kind.toUpperCase()}</td>
                  <td>{(file.sizeBytes / 1024).toFixed(1)} KB</td>
                  <td className="mono">{file.fileName.slice(0, 8)}…</td>
                  <td><a className="btn small" href={downloadUrl(file.id)} download>下载 HTML</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>规划记录</h2>
          <span className="card-index">02 / 规划</span>
        </div>
        <p className="sub">需求、候选方案与最终指南按账号保留</p>
        {plansError && <div className="error">{plansError}</div>}
        {plans.length === 0 && !plansError ? (
          <p className="muted">还没有规划记录</p>
        ) : (
          <table>
            <thead><tr><th>创建时间</th><th>需求</th><th>候选方案</th><th>指南</th></tr></thead>
            <tbody>
              {plans.map((plan) => (
                <tr key={plan.id}>
                  <td>{fmt(plan.createdAt)}</td>
                  <td>{plan.requirement.slice(0, 40)}{plan.requirement.length > 40 ? '…' : ''}</td>
                  <td>{plan.options?.length ?? 0} 个{plan.selectedIndex !== null ? ` · 已选第 ${plan.selectedIndex + 1} 个` : ''}</td>
                  <td>{plan.guide ? '已生成' : '未生成'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>登录会话记录</h2>
          <span className="card-index">03 / 会话</span>
        </div>
        <p className="sub">服务端会话可追溯；退出登录后对应会话标记为已失效</p>
        {sessionsError && <div className="error">{sessionsError}</div>}
        <table>
          <thead><tr><th>创建时间</th><th>状态</th><th>IP</th><th>客户端</th><th>到期</th></tr></thead>
          <tbody>
            {sessions.map((session) => (
              <tr key={session.id}>
                <td>{fmt(session.createdAt)}</td>
                <td>
                  {session.current ? <span className="badge">当前会话</span> : null}
                  {session.revokedAt ? '已失效' : new Date(session.expiresAt).getTime() < Date.now() ? '已过期' : '有效'}
                </td>
                <td className="mono">{session.ip || '-'}</td>
                <td>{session.userAgent ? session.userAgent.slice(0, 42) : '-'}</td>
                <td>{fmt(session.expiresAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
