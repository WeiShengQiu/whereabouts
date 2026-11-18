import { useEffect, useState, type FormEvent } from 'react'
import { api, errorMessage } from '../api'
import { DEFAULT_CONFIG_ID, PROTOCOL_LABELS, PROTOCOLS } from '../../../shared/types'
import type { LLMConfigView, ModelInfo, Protocol } from '../../../shared/types'

interface FormState {
  name: string
  protocol: Protocol
  baseUrl: string
  apiKey: string
  defaultModel: string
}

const EMPTY_FORM: FormState = {
  name: '',
  protocol: 'chat_completions',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  defaultModel: '',
}

export default function SettingsPage() {
  const [configs, setConfigs] = useState<LLMConfigView[]>([])
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [modelReason, setModelReason] = useState('')
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    setConfigs(await api.configs())
  }

  useEffect(() => {
    refresh().catch((e) => setError(errorMessage(e)))
  }, [])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    setSuccess('')
    if (!editingId && !form.apiKey.trim()) {
      setError('新增配置需要填写 API Key')
      return
    }
    setBusy(true)
    try {
      if (editingId) await api.updateConfig(editingId, form)
      else await api.createConfig({ ...form, apiKey: form.apiKey.trim() })
      setSuccess(editingId ? '配置已更新' : '配置已保存')
      setForm(EMPTY_FORM)
      setEditingId(null)
      setModels([])
      setModelReason('')
      setTestResult(null)
      await refresh()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const edit = (config: LLMConfigView) => {
    setEditingId(config.id)
    setForm({
      name: config.name,
      protocol: config.protocol,
      baseUrl: config.baseUrl,
      apiKey: '',
      defaultModel: config.defaultModel,
    })
    setModels([])
    setModelReason('')
    setTestResult(null)
    setError('')
    setSuccess('')
  }

  const remove = async (config: LLMConfigView) => {
    if (!window.confirm(`确定删除配置「${config.name}」？已生成的指南不受影响，但依赖该配置的历史规划将无法继续生成。`)) return
    try {
      await api.deleteConfig(config.id)
      if (editingId === config.id) {
        setEditingId(null)
        setForm(EMPTY_FORM)
      }
      await refresh()
      setSuccess('配置已删除')
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const fetchModels = async () => {
    if (!editingId) {
      setError('请先保存配置，再获取模型列表')
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await api.models(editingId)
      setModels(result.models)
      setModelReason(result.reason)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    if (!editingId) {
      setError('请先保存配置，再测试连通性')
      return
    }
    if (!form.defaultModel.trim()) {
      setError('请先填写默认模型名')
      return
    }
    setBusy(true)
    setError('')
    try {
      setTestResult(await api.testConfig(editingId, form.defaultModel.trim()))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="hero">
        <p className="eyebrow">MODEL SETTINGS · 模型设置</p>
        <h1>连接你的<em>大模型服务</em></h1>
        <p className="hero-sub">支持三种主流协议，密钥加密落库，可随时切换、获取模型列表并测试连通性。</p>
      </div>
      <div className="card">
        <div className="card-head">
          <h2>{editingId ? '编辑模型配置' : '新增模型配置'}</h2>
          <span className="card-index">01 / 配置</span>
        </div>
        <p className="sub">支持 OpenAI Chat Completions / OpenAI Responses / Anthropic Messages 三种协议</p>
        <form onSubmit={save}>
          <div className="row">
            <div className="field">
              <label htmlFor="name">配置名称</label>
              <input id="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如 官方 OpenAI / 中转站" required />
            </div>
            <div className="field">
              <label htmlFor="protocol">协议</label>
              <select id="protocol" value={form.protocol} onChange={(e) => setForm({ ...form, protocol: e.target.value as Protocol })}>
                {PROTOCOLS.map((protocol) => <option key={protocol} value={protocol}>{PROTOCOL_LABELS[protocol]}</option>)}
              </select>
            </div>
          </div>
          <div className="field" style={{ marginTop: 16 }}>
            <label htmlFor="baseUrl">API 地址（填到版本前缀）</label>
            <input id="baseUrl" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" required />
            <p className="hint">OpenAI 系一般填 /v1；Anthropic 填 https://api.anthropic.com/v1；粘贴完整端点路径也会自动归一化</p>
          </div>
          <div className="row">
            <div className="field">
              <label htmlFor="apiKey">API Key {editingId ? '（留空表示不修改）' : ''}</label>
              <input id="apiKey" type="password" autoComplete="off" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder={editingId ? '不修改请留空' : 'sk-...'} required={!editingId} />
              <p className="hint">加密后落库，接口不会回显明文</p>
            </div>
            <div className="field">
              <label htmlFor="defaultModel">默认模型</label>
              <input id="defaultModel" value={form.defaultModel} onChange={(e) => setForm({ ...form, defaultModel: e.target.value })} placeholder="gpt-4o-mini" />
            </div>
          </div>
          <div className="row" style={{ marginTop: 18, gap: 10 }}>
            <button className="btn primary" disabled={busy}>{editingId ? '保存修改' : '新增配置'}</button>
            {editingId && <button type="button" className="btn" onClick={() => { setEditingId(null); setForm(EMPTY_FORM); setModels([]); setModelReason(''); setTestResult(null) }}>取消编辑</button>}
            <button type="button" className="btn" onClick={fetchModels} disabled={busy}>获取模型列表</button>
            <button type="button" className="btn" onClick={test} disabled={busy}>测试连通</button>
          </div>
        </form>
        {models.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <label>可选模型（点击设为默认）</label>
            <div>
              {models.map((item) => <button type="button" className="pill" key={item.id} onClick={() => setForm({ ...form, defaultModel: item.id })}>{item.id}</button>)}
            </div>
          </div>
        )}
        {modelReason && <p className="hint">{modelReason}</p>}
        {testResult && <div className={testResult.ok ? 'success' : 'error'}>{testResult.message}</div>}
        {error && <div className="error">{error}</div>}
        {success && <div className="success">{success}</div>}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>已保存的配置</h2>
          <span className="card-index">02 / 列表</span>
        </div>
        <p className="sub">密钥永不回显；切换协议后请重新测试连通性</p>
        {configs.length === 0 ? (
          <p className="muted">还没有配置，先新增一个再开始规划行程</p>
        ) : (
          <table>
            <thead><tr><th>名称</th><th>协议</th><th>API 地址</th><th>默认模型</th><th>操作</th></tr></thead>
            <tbody>
              {configs.map((config) => (
                <tr key={config.id}>
                  <td>{config.name}</td>
                  <td>{PROTOCOL_LABELS[config.protocol]}</td>
                  <td className="mono">{config.baseUrl}</td>
                  <td className="mono">{config.defaultModel || '-'}</td>
                  <td>
                    {config.id === DEFAULT_CONFIG_ID ? (
                      <span className="muted">系统内置 · 只读</span>
                    ) : (
                      <>
                        <button className="btn small" onClick={() => edit(config)}>编辑</button>{' '}
                        <button className="btn small danger" onClick={() => void remove(config)}>删除</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
