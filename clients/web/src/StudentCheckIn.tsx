import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  ApiError, attendanceQrToken, statusLabel, timeLabel, type Coordinates, type Mark, type QrPreview, type User,
} from '@attendance/shared'
import { Brand, ErrorNotice, messageOf } from './App'
import { authorized, login, logout, refresh } from './auth'

function currentPosition(): Promise<Coordinates> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Геолокация недоступна. Откройте ссылку в браузере по HTTPS на телефоне.'))
      return
    }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({
        latitude: coords.latitude, longitude: coords.longitude, horizontal_accuracy: coords.accuracy,
      }),
      error => reject(new Error(error.code === 1
        ? 'Разрешите геолокацию для Attendance в настройках браузера и повторите попытку.'
        : 'Не удалось определить геопозицию. Проверьте, включена ли геолокация на телефоне.')),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 12_000 },
    )
  })
}

export function StudentCheckIn() {
  const [token] = useState(() => attendanceQrToken(new URLSearchParams(location.hash.slice(1)).get('code') ?? ''))
  const [user, setUser] = useState<User | null>(null)
  const [preview, setPreview] = useState<QrPreview | null>(null)
  const [mark, setMark] = useState<Mark | null>(null)
  const [loading, setLoading] = useState(Boolean(token))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const submitting = useRef(false)

  useEffect(() => {
    if (!token) return
    void refresh().then(result => {
      if (result.user.role === 'ROLE_STUDENT') setUser(result.user)
    }).catch(cause => {
      if (!(cause instanceof ApiError) || cause.status !== 401) setError(messageOf(cause))
    }).finally(() => setLoading(false))
    const expired = () => {
      setUser(null)
      setPreview(null)
      setError('Срок входа истёк. Войдите снова.')
    }
    window.addEventListener('attendance:expired', expired)
    return () => window.removeEventListener('attendance:expired', expired)
  }, [token])

  useEffect(() => {
    if (!user || !token) return
    let mounted = true
    setError('')
    void authorized<QrPreview>('/attendance/qr/preview', { method: 'POST', body: { token } }).then(data => {
      if (!mounted) return
      setPreview(data)
      setMark(data.mark)
    }).catch(cause => { if (mounted) setError(messageOf(cause)) })
    return () => { mounted = false }
  }, [user, token, retry])

  async function enter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current) return
    const fields = new FormData(event.currentTarget)
    submitting.current = true
    setBusy(true)
    setError('')
    try {
      const result = await login(String(fields.get('login')), String(fields.get('password')))
      if (result.user.role !== 'ROLE_STUDENT') throw new Error('Войдите под учётной записью студента.')
      setUser(result.user)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  async function confirm() {
    if (!token || submitting.current) return
    submitting.current = true
    setBusy(true)
    setError('')
    try {
      const point = await currentPosition()
      setMark(await authorized<Mark>('/attendance/qr', { method: 'POST', body: { token, ...point } }))
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  async function switchAccount() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await logout()
      setUser(null)
      setPreview(null)
      setMark(null)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  return <div className="login-page">
    <header className="login-header"><Brand /></header>
    <main className="login-main">
      <section className="panel login-card check-in-card">
        <h1>Подтверждение присутствия</h1>
        {!token ? <ErrorNotice message="Откройте QR-код занятия с экрана преподавателя." />
          : loading ? <p role="status" className="muted">Подключаемся…</p>
            : !user ? <form onSubmit={enter}>
              <p className="muted">Войдите под своей учётной записью студента.</p>
              <label className="field">Логин<input name="login" autoComplete="username" required maxLength={254} /></label>
              <label className="field">Пароль<input name="password" type="password" autoComplete="current-password"
                required maxLength={256} /></label>
              {error && <ErrorNotice message={error} />}
              <button className="button primary" disabled={busy}>{busy ? 'Входим…' : 'Войти'}</button>
            </form> : <>
              <div className="check-in-identity"><strong>{user.display_name}</strong>
                <button className="location-link" disabled={busy} onClick={() => void switchAccount()}>Сменить аккаунт</button>
              </div>
              {preview && <div className="check-in-lesson">
                <h2>{preview.subject}</h2>
                <span>{timeLabel(preview.starts_at)} · {preview.building_name} · ауд. {preview.room}</span>
              </div>}
              {mark ? <div className="check-in-result" role="status">Отметка сохранена в {timeLabel(mark.created_at)} · {statusLabel(mark.status)}</div>
                : preview ? <>
                  <p className="muted">Для подтверждения браузер запросит геолокацию. Сервер проверит, что телефон находится в геозоне корпуса.</p>
                  <button className="button primary" disabled={busy} onClick={() => void confirm()}>
                    {busy ? 'Проверяем присутствие…' : 'Подтвердить присутствие'}
                  </button>
                </> : error ? <button className="button secondary" onClick={() => setRetry(value => value + 1)}>Повторить загрузку</button>
                  : <p role="status" className="muted">Проверяем занятие…</p>}
              {error && <ErrorNotice message={error} />}
            </>}
      </section>
    </main>
    <footer className="login-footer">Attendance</footer>
  </div>
}
