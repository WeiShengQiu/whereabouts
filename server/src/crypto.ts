import crypto from 'node:crypto'

let cachedKey: Buffer | null = null

/** 延迟读取，避免依赖 dotenv 的 import 求值顺序 */
function encKey(): Buffer {
  if (cachedKey) return cachedKey
  const hex = process.env.APP_ENCRYPTION_KEY ?? ''
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    cachedKey = Buffer.from(hex, 'hex')
  } else if (process.env.NODE_ENV === 'production') {
    throw new Error('生产环境必须配置 APP_ENCRYPTION_KEY（64 位 hex）')
  } else {
    console.warn('[warn] APP_ENCRYPTION_KEY 未配置，本次启动使用临时密钥；重启后已加密的 API Key 将无法解密')
    cachedKey = crypto.randomBytes(32)
  }
  return cachedKey
}

/** scrypt 密码哈希，格式 scrypt:salt:hash */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password, salt, 64)
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split(':')
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length)
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}

/** AES-256-GCM 加密大模型 API Key，格式 iv.tag.cipher（均为 base64url） */
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv)
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.')
}

export function decryptSecret(payload: string): string {
  const [iv, tag, data] = payload.split('.')
  if (!iv || !tag || !data) throw new Error('API Key 密文格式损坏，请重新保存配置')
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8')
}

export const newId = (): string => crypto.randomUUID()
export const newToken = (): string => crypto.randomBytes(32).toString('base64url')
export const sha256 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex')
