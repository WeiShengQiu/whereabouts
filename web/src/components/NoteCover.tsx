import { useState } from 'react'
import { coverSrc, safeCover } from '../../../shared/research-view'

interface Props {
  /** 小红书 CDN 原图地址（可能是协议相对地址） */
  cover: string | null | undefined
  alt?: string
  className?: string
}

/**
 * 小红书封面图：先直连（不带 Referer，绕开图床防盗链），
 * 失败后自动改走同源后端代理，仍失败则退化为文字占位，绝不显示破图。
 */
export default function NoteCover({ cover, alt = '', className }: Props) {
  const direct = safeCover(cover)
  const [src, setSrc] = useState(direct)
  const [failed, setFailed] = useState(!direct)

  if (failed || !direct) {
    return <span className={`note-cover-ph${className ? ` ${className}` : ''}`} aria-hidden>小红书</span>
  }

  return (
    <img
      className={className}
      src={src}
      alt={alt}
      loading="lazy"
      // 关键：不发送 Referer，避免被小红书图床判定为外站盗链
      referrerPolicy="no-referrer"
      onError={() => {
        const proxy = coverSrc(direct)
        if (src !== proxy) setSrc(proxy)
        else setFailed(true)
      }}
    />
  )
}
