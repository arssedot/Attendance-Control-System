export type Role = 'ROLE_TEACHER' | 'ROLE_STUDENT'
export type SessionState = 'ACTIVE' | 'EXPIRED' | 'CLOSED'

export interface User {
  id: string
  login: string
  display_name: string
  role: Role
}

export interface Tokens {
  user: User
  access_token: string
  expires_in: number
  refresh_token?: string
}

export interface Lesson {
  id: string
  subject: string
  group_name: string
  teacher_name: string
  building_name: string
  room: string
  starts_at: string
  ends_at: string
  session_id: string | null
  session_state: SessionState | null
  marked: boolean
  source: 'LOCAL' | 'UNN'
  geozone_configured: boolean
}

export interface Session {
  id: string
  schedule_id: string
  state: SessionState
  issued_at: string
  expires_at: string
  late_at: string
  closed_at: string | null
  qr_image: string | null
  server_time: string
}

export interface Mark {
  session_id: string
  schedule_id: string
  created_at: string
  method: 'QR' | 'GEO'
  status: 'PRESENT' | 'LATE'
}

export interface Coordinates {
  latitude: number
  longitude: number
  horizontal_accuracy: number
}

export interface QrPreview {
  subject: string
  student_name: string
  building_name: string
  room: string
  starts_at: string
  mark: Mark | null
}

export function attendanceQrToken(value: string): string | undefined {
  const code = value.trim().match(/^https:\/\/[^/?#]+\/check-in#code=([\w-]+)$/i)?.[1] ?? value.trim()
  return /^[A-Za-z0-9_-]{100,200}$/.test(code) ? code : undefined
}

export interface RosterMark extends Mark {
  student_id: string
  student_name: string
  has_location: boolean
}

export interface MarkLocation {
  latitude: number
  longitude: number
  horizontal_accuracy: number
  building_name: string
}

export interface HistoryMark extends Mark {
  subject: string
  starts_at: string
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH'
  body?: object
  token?: string
}

export async function apiRequest<T>(base: string, path: string, options: ApiOptions = {}): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12_000)
  try {
    const response = await fetch(`${base}/api/v1${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: base ? 'omit' : 'same-origin',
      signal: controller.signal,
    })
    if (!response.ok) {
      const error = await response.json().catch(() => null)
      throw new ApiError(response.status, error?.code ?? 'HTTP_ERROR',
        error?.message ?? 'Сервис не смог выполнить запрос. Повторите попытку.')
    }
    return response.status === 204 ? undefined as T : await response.json() as T
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(0, 'NETWORK_ERROR', controller.signal.aborted
      ? 'Сервер отвечает слишком долго. Повторите попытку.'
      : 'Нет связи с сервером. Проверьте подключение к сети.')
  } finally {
    clearTimeout(timeout)
  }
}

export type AuthorizedRequest = <T>(path: string, options?: ApiOptions) => Promise<T>

export async function readPage<T>(
  request: AuthorizedRequest, path: string, offset = 0,
): Promise<T[]> {
  return request<T[]>(`${path}${path.includes('?') ? '&' : '?'}limit=50&offset=${offset}`)
}

export const timeLabel = (value: string) =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' })
    .format(new Date(value))

export const statusLabel = (status: Mark['status']) => status === 'PRESENT' ? 'Вовремя' : 'Опоздание'
export const methodLabel = (method: Mark['method']) => method === 'QR' ? 'QR-код' : 'Геолокация'

export function moscowDate(value = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value)
  const part = (name: string) => parts.find(item => item.type === name)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}
