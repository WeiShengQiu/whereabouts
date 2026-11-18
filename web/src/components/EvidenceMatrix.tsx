import { EVIDENCE_SOURCE_LABELS } from '../../../shared/types'
import type { EvidenceBundle, EvidenceMatrix as Matrix, EvidenceSource, SourceStatus } from '../../../shared/types'

const STATE_LABEL: Record<SourceStatus['state'], string> = {
  ready: '已获取',
  no_key: '未启用',
  disabled: '已禁用',
  degraded: '已熔断',
  empty: '未获取',
}

export default function EvidenceMatrix({ bundle }: { bundle: EvidenceBundle | null }) {
  if (!bundle || bundle.matrices.length === 0) {
    return (
      <div className="card ev-card">
        <div className="card-head">
          <h2>第三方口碑对比</h2>
          <span className="card-index">DATA / 未取证</span>
        </div>
        <p className="sub">本次模型没有提取到可核对的具体地点，指南不会包含任何评分描述。</p>
        <p className="hint">可在「口碑数据」页手动录入或导入 CSV，下一次生成时会自动带入对比。</p>
      </div>
    )
  }

  return (
    <div className="card ev-card">
      <div className="card-head">
        <h2>第三方口碑对比</h2>
        <span className="card-index">DATA / {bundle.matrices.length} 个地点</span>
      </div>
      <p className="sub">
        评分只来自授权通道、开放数据集或你录入的数据；各平台口径不同，不做跨平台平均。取证于{' '}
        {new Date(bundle.collectedAt).toLocaleString('zh-CN')}
      </p>
      {bundle.degraded.length > 0 && (
        <div className="hint ev-warn">
          本次熔断降级：{bundle.degraded.map((id) => EVIDENCE_SOURCE_LABELS[id as EvidenceSource] ?? id).join('、')}
          （触发风控或限流，已改用回源链接，不重试）
        </div>
      )}
      {bundle.matrices.map((matrix: Matrix) => (
        <div className="ev-block" key={matrix.poiName}>
          <h3 className="section-title">{matrix.poiName}</h3>
          <div className="ev-scroll">
            <table className="ev-table">
              <thead>
                <tr>
                  <th>来源</th>
                  <th>评分</th>
                  <th>评价数</th>
                  <th>状态</th>
                  <th>回源</th>
                </tr>
              </thead>
              <tbody>
                {matrix.sources.map((source) => {
                  const first = matrix.items.find((item) => item.source === source.id)
                  return (
                    <tr key={source.id}>
                      <td>{source.label}</td>
                      <td>
                        {first?.rating != null ? (
                          <b className="ev-score">
                            {first.rating.toFixed(1)}<small> / 5</small>
                          </b>
                        ) : (
                          <span className="ev-none">—</span>
                        )}
                        {first?.ratingRaw && <small className="ev-raw">{first.ratingRaw}</small>}
                      </td>
                      <td>{first?.reviewCount ?? <span className="ev-none">—</span>}</td>
                      <td>
                        <span className={`ev-state ${source.state}`} title={source.reason}>
                          {STATE_LABEL[source.state]}
                        </span>
                      </td>
                      <td>
                        {source.deepLink ? (
                          <a href={source.deepLink} target="_blank" rel="noopener noreferrer">
                            查看
                          </a>
                        ) : (
                          <span className="ev-none">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="hint">
            未获取：{matrix.sources.filter((source) => source.itemCount === 0).map((source) => source.label).join('、') || '无'}。
            {matrix.items.length
              ? `共 ${matrix.items.length} 条证据，最近获取于 ${matrix.items[0].fetchedAt.slice(0, 10)}。`
              : '本次没有任何源返回数据，指南中不会写出评分。'}
          </p>
        </div>
      ))}
    </div>
  )
}
