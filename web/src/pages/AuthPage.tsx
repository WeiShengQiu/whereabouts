import { useEffect, useState, type FormEvent } from 'react'
import { api, errorMessage } from '../api'
import type { UserView } from '../../../shared/types'

interface Props {
  onAuthed: (user: UserView) => void
}

export default function AuthPage({ onAuthed }: Props) {
  const [mode, setMode] = useState<'login' | 'register'>('register')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [wechat, setWechat] = useState<{ enabled: boolean; reason: string } | null>(null)

  useEffect(() => {
    api.wechatStatus().then(setWechat).catch(() => setWechat(null))
  }, [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const user = mode === 'login' ? await api.login(email, password) : await api.register(email, password)
      onAuthed(user)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-brand">
        <p className="eyebrow">CURATED JOURNEYS</p>
        <h1>行迹<span>◈</span></h1>
        <p>不必在几十篇攻略里来回比对。说出你的想法，让 AI 生成真正贴合你的行程方向，再打磨成一份可以直接带走的指南。</p>
        <div className="auth-quote">「好的旅行，从一份懂你的计划开始。」</div>
      </div>
      <div className="auth-card">
        <h2>{mode === 'login' ? '欢迎回来' : '开启你的旅程'}</h2>
        <p className="sub">邮箱直注登录，无需验证码</p>
        <div className="tabs">
          <button className={mode === 'register' ? 'active' : ''} onClick={() => { setMode('register'); setError('') }}>注册</button>
          <button className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setError('') }}>登录</button>
        </div>
        <form onSubmit={(e) => void submit(e)}>
          <div className="field">
            <label htmlFor="email">邮箱</label>
            <input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
          </div>
          <div className="field">
            <label htmlFor="password">密码</label>
            <input id="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少 8 位" minLength={8} required />
          </div>
          {error && <div className="error">{error}</div>}
          <button className="btn primary" style={{ width: '100%', marginTop: 8 }} disabled={busy}>
            {busy ? '处理中…' : mode === 'login' ? '登录' : '注册并进入'}
          </button>
        </form>
        <div className="wechat-note">
          {wechat?.enabled
            ? '微信登录已启用'
            : `微信登录未启用 · ${wechat?.reason ?? '本期先使用邮箱直注'}`}
          <br />
          邮箱注册不发送验证码，请勿使用他人邮箱；生产环境建议补邮箱验证或更换 OAuth。
        </div>
      </div>
    </div>
  )
}
