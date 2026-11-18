import NoteCover from './NoteCover'
import {
  fallbackGeoPoi,
  matchGeoPoi,
  renderGeoStatus,
  renderRouteMap,
  renderSpotMapCard,
} from '../../../shared/geo-view'
import { heatLabel, matchNotes } from '../../../shared/research-view'
import type { PlanView } from '../../../shared/types'

interface Props {
  plan: PlanView
}

/** 指南正文：概览、逐日行程、地点图册（含相关小红书笔记）、预算与行前清单 */
export default function GuideView({ plan }: Props) {
  const guide = plan.guide
  if (!guide) return null
  const spots = guide.spots ?? []

  return (
    <div className="guide-body">
      <div className="guide-hero">
        <p className="eyebrow">YOUR TRAVEL GUIDE · 定制指南</p>
        <h2>{guide.title}</h2>
        <p className="muted">
          {guide.destination}　·　{guide.duration}
          {plan.version > 1 && <span className="version-tag">第 {plan.version} 版</span>}
        </p>
      </div>
      <div className="guide-overview">{guide.overview}</div>

      {spots.length > 0 && (
        <>
          <div className="sep" />
          <h3 className="section-title">行程总览</h3>
          <div dangerouslySetInnerHTML={{ __html: renderRouteMap(spots, plan.geo) }} />
          <div dangerouslySetInnerHTML={{ __html: renderGeoStatus(plan.geo) }} />
        </>
      )}

      <div className="sep" />
      <h3 className="section-title">每日行程</h3>
      <div className="day-list">
        {guide.days.map((day, index) => (
          <div className="day" key={`${day.day}-${index}`}>
            <h3><span className="day-no">D{index + 1}</span>{day.day} · {day.title}</h3>
            <dl>
              <div><dt>上午</dt><dd>{day.morning}</dd></div>
              <div><dt>下午</dt><dd>{day.afternoon}</dd></div>
              <div><dt>晚上</dt><dd>{day.evening}</dd></div>
              <div><dt>餐饮</dt><dd>{day.meals}</dd></div>
              <div><dt>交通</dt><dd>{day.transport}</dd></div>
              <div><dt>贴士</dt><dd>{day.tips}</dd></div>
            </dl>
          </div>
        ))}
      </div>

      <div className="sep" />
      <h3 className="section-title">地点图册 · 图文详解</h3>
      {spots.length === 0 ? (
        <p className="muted">本指南未包含地点图册（历史记录或模型未返回图册数据）。</p>
      ) : (
        <div className="spot-grid">
          {spots.map((spot, index) => {
            const poi = matchGeoPoi(plan.geo, spot.name) ?? fallbackGeoPoi(spot.name, plan.geo?.city ?? '')
            const relatedNotes = matchNotes(plan.research?.items ?? [], spot.name, spot.category, 2)
            return (
              <article className="spot" key={`spot-${index}`}>
                <div dangerouslySetInnerHTML={{ __html: renderSpotMapCard(poi, index) }} />
                <div className="spot-body">
                  <div className="spot-tags">
                    <span>{spot.category}</span><span>{spot.day} {spot.time}</span>
                    <span>停留 {spot.stay}</span><span>{spot.cost}</span>
                  </div>
                  <p className="spot-intro">{spot.intro}</p>
                  {spot.highlights.length > 0 && (
                    <ul className="spot-list">{spot.highlights.map((item, i) => <li key={`h-${i}`}>{item}</li>)}</ul>
                  )}
                  <p className="spot-extra"><b>贴士</b>{spot.tips}</p>
                  <p className="spot-extra"><b>取景</b>{spot.photo}</p>
                  {relatedNotes.length > 0 && (
                    <div className="spot-notes">
                      <p className="spot-notes-title">相关小红书笔记（用户实采 · 非评分）</p>
                      {relatedNotes.map((note) => (
                        <a className="spot-note" href={note.url} target="_blank" rel="noopener noreferrer" key={note.id}>
                          <NoteCover cover={note.cover} alt="" />
                          <span className="spot-note-text">
                            <b>{note.title || '（无标题笔记）'}</b>
                            <small>
                              {note.author ? `@${note.author}` : '小红书笔记'}
                              {heatLabel(note.likes) ? ` · ${heatLabel(note.likes)}` : ''} ↗
                            </small>
                          </span>
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}

      <div className="sep" />
      <h3 className="section-title">预算参考</h3>
      <p><span className="pill">{guide.budget.level}</span><span className="pill">合计 {guide.budget.total}</span></p>
      {guide.budget.items.map((item, index) => <span className="pill" key={`budget-${index}`}>{item}</span>)}

      <div className="sep" />
      <div className="grid-2">
        <div><h3 className="section-title">行前清单</h3>{guide.packing.map((item, index) => <p className="muted" key={`packing-${index}`}>· {item}</p>)}</div>
        <div><h3 className="section-title">注意事项</h3>{guide.notes.map((item, index) => <p className="muted" key={`note-${index}`}>· {item}</p>)}</div>
      </div>
    </div>
  )
}
