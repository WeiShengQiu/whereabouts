import { useEffect, useState } from 'react'
import { api } from './api'
import type { UserView } from '../../shared/types'
import AuthPage from './pages/AuthPage'
import PlannerPage from './pages/PlannerPage'
import EvidencePage from './pages/EvidencePage'
import SettingsPage from './pages/SettingsPage'
import HistoryPage from './pages/HistoryPage'

type View = 'planner' | 'evidence' | 'settings' | 'history'
const NAV: Array<{ key: View; label: string }> = [
  { key: 'planner', label: '行程规划' },
  { key: 'evidence', label: '口碑数据' },
  { key: 'settings', label: '模型设置' },
  { key: 'history', label: '我的记录' },
]

export default function App() {
  const [user, setUser] = useState<UserView | null>(null)
  const [checking, setChecking] = useState(true)
  const [view, setView] = useState<View>('planner')

  useEffect(() => {
    api.me()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setChecking(false))
  }, [])

  if (checking) return <div className="loading">正在检查登录状态…</div>
  if (!user) return <AuthPage onAuthed={setUser} />

  const logout = async () => {
    await api.logout().catch(() => undefined)
    setUser(null)
  }

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◈</span>
          <span>行迹</span>
          <small>TRAVEL STUDIO</small>
        </div>
        <nav className="nav">
          {NAV.map((item) => (
            <button key={item.key} className={view === item.key ? 'active' : ''} onClick={() => setView(item.key)}>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="user-chip">
          <span className="avatar">{user.email.slice(0, 1).toUpperCase()}</span>
          <span>{user.email}</span>
          <button className="btn ghost" onClick={() => void logout()}>退出</button>
        </div>
      </header>
      <main className="container">
        {view === 'planner' && <PlannerPage />}
        {view === 'evidence' && <EvidencePage />}
        {view === 'settings' && <SettingsPage />}
        {view === 'history' && <HistoryPage />}
      </main>
      <footer className="site-footer">行迹 · CURATED JOURNEYS　/　AI 生成内容，请在出行前通过官方渠道二次核实</footer>
    </>
  )
}
