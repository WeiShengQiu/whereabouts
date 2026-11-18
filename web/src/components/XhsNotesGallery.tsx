import { RESEARCH_CATEGORY_LABELS, type ResearchBundle } from '../../../shared/types'
import { heatLabel, notesByCategory, safeCover } from '../../../shared/research-view'

/**
 * 指南页的口碑展示：只贴用户自己采集的小红书具体笔记（封面 + 标题 + 作者 + 热度 + 回源链接）。
 * 不再展示来源混乱、多数未取到的第三方评分表。
 */
export default function XhsNotesGallery({ research }: { research: ResearchBundle | null }) {
  const groups = notesByCategory(research)
  const total = research?.items.length ?? 0

  return (
    <div className="card xhs-gallery-card">
      <div className="card-head">
        <h2>小红书实采笔记</h2>
        <span className="card-index">DATA / {total ? `${total} 篇笔记` : '暂无'}</span>
      </div>
      <p className="sub">
        以下都是你用浏览器在小红书实采的具体笔记，作为目的地、店名、玩法与避坑的参考。
        <b>这些不是评分</b>，点赞只是内容热度；营业时间、票价与地址请以官方渠道为准。
      </p>

      {total === 0 ? (
        <p className="hint">
          本次没有实采笔记。在上方「小红书实采线索」安装扩展并登录小红书后，生成方案时会自动采集并展示在这里。
        </p>
      ) : (
        groups.map((group) => (
          <div className="xhs-group" key={group.category}>
            <h3 className="section-title">{RESEARCH_CATEGORY_LABELS[group.category]}（{group.items.length}）</h3>
            <div className="xhs-card-grid">
              {group.items.map((note) => {
                const cover = safeCover(note.cover)
                return (
                  <a className="xhs-card" href={note.url} target="_blank" rel="noopener noreferrer" key={note.id}>
                    <div className="xhs-card-cover">
                      {cover ? <img src={cover} alt="" loading="lazy" /> : <span className="xhs-card-ph">小红书笔记</span>}
                    </div>
                    <div className="xhs-card-body">
                      <b>{note.title || '（无标题笔记）'}</b>
                      <small>
                        {note.author ? `@${note.author}` : '小红书用户'}
                        {heatLabel(note.likes) && ` · ${heatLabel(note.likes)}`}
                      </small>
                      {note.summary && <span className="xhs-card-summary">{note.summary.slice(0, 60)}</span>}
                    </div>
                  </a>
                )
              })}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
