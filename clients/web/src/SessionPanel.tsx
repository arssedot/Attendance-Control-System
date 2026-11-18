import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Clock3, Expand, ScanLine, X } from 'lucide-react'
import { type Lesson, type Session, timeLabel } from '@attendance/shared'
import { ErrorNotice, messageOf } from './App'
import { authorized } from './auth'

function useRemaining(session: Session | null) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    setElapsed(0)
    if (session?.state !== 'ACTIVE') return
    const start = performance.now()
    const interval = window.setInterval(() => setElapsed(performance.now() - start), 250)
    return () => window.clearInterval(interval)
  }, [session])
  if (session?.state !== 'ACTIVE') return 0
  return Math.max(0, Math.ceil((Date.parse(session.expires_at) - Date.parse(session.server_time) - elapsed) / 1000))
}

function countdown(seconds: number) {
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}

export function SessionPanel({ lesson, onUpdate }: { lesson: Lesson; onUpdate: (session: Session) => void }) {
  const [session, setSession] = useState<Session | null>(null)
  const [ttl, setTtl] = useState(10)
  const [late, setLate] = useState(5)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [confirmClose, setConfirmClose] = useState(false)
  const projector = useRef<HTMLDialogElement>(null)
  const remaining = useRemaining(session)
  const sessionId = lesson.session_id
  const start = lesson.starts_at
  const image = remaining > 0 ? session?.qr_image : null

  useEffect(() => {
    if (!sessionId) return
    let ignore = false
    setBusy(true)
    setError('')
    void authorized<Session>(`/sessions/${sessionId}`).then(data => {
      if (ignore) return
      setSession(data)
      setLate(Math.round((Date.parse(data.late_at) - Date.parse(start)) / 60_000))
    }).catch(cause => { if (!ignore) setError(messageOf(cause)) })
      .finally(() => { if (!ignore) setBusy(false) })
    return () => { ignore = true }
  }, [sessionId, start, retry])

  useEffect(() => {
    if (!image && projector.current?.open) projector.current.close()
  }, [image])

  async function save(close = false) {
    setBusy(true)
    setError('')
    const payload = { ttl_minutes: ttl, late_after_minutes: late }
    try {
      const data = session
        ? await authorized<Session>(`/sessions/${session.id}`, {
          method: 'PATCH', body: close ? { close: true } : payload,
        })
        : await authorized<Session>('/sessions', {
          method: 'POST', body: { ...payload, schedule_id: lesson.id },
        })
      setSession(data)
      onUpdate(data)
      setConfirmClose(false)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    void save()
  }

  const mayUpdate = !lesson.session_id || (session?.state !== 'CLOSED' && session !== null)
  return <section className="panel session-panel" aria-busy={busy}>
    <div className="panel-heading">
      <div className="heading-icon"><ScanLine size={20} /></div>
      <div><h2>Сессия занятия</h2><p>{lesson.subject}</p></div>
      {image && <span className="badge positive end">Открыта</span>}
    </div>
    {error && <ErrorNotice message={error} />}
    {sessionId && !session && error && <button className="button secondary more" disabled={busy}
      onClick={() => setRetry(value => value + 1)}>Повторить загрузку</button>}
    {image && <div className="qr-area">
      <div className="qr-frame"><img alt="QR-код для отметки на занятии" src={image} width="212" height="212" /></div>
      <div className="qr-caption">
        <span className="timer"><Clock3 size={17} />{countdown(remaining)}</span>
        <button className="button secondary" onClick={() => projector.current?.showModal()}><Expand size={16} />На экран</button>
      </div>
    </div>}
    {!sessionId && <div className="session-preview"><ScanLine size={28} /><p>QR-код появится после открытия регистрации.</p></div>}
    {session && !image && <div className="session-preview"><Clock3 size={28} />
      <p>{session.state === 'CLOSED' ? 'Регистрация завершена.' : 'Срок регистрации истёк.'}</p>
    </div>}
    {mayUpdate && <form className="session-form" onSubmit={submit}>
      <div className="form-grid">
        <label className="field">Регистрация, мин.
          <input type="number" value={ttl} min={1} max={120} required disabled={busy}
            onChange={event => setTtl(event.target.valueAsNumber)} />
        </label>
        <label className="field">Опоздание после, мин.
          <input type="number" value={late} min={0} max={30} required disabled={busy}
            onChange={event => setLate(event.target.valueAsNumber)} />
        </label>
      </div>
      <button className="button primary" disabled={busy}>{session ? 'Обновить срок и QR-код' : 'Открыть регистрацию'}</button>
      {session && !confirmClose && <button className="button danger" type="button" disabled={busy}
        onClick={() => setConfirmClose(true)}>Завершить регистрацию</button>}
      {session && confirmClose && <div className="confirm" role="group" aria-label="Подтверждение завершения">
        <p>После завершения студенты больше не смогут отметиться.</p>
        <button className="button danger" type="button" disabled={busy} onClick={() => void save(true)}>Подтвердить завершение</button>
        <button className="button secondary" type="button" onClick={() => setConfirmClose(false)}>Отмена</button>
      </div>}
    </form>}
    <dialog className="projector" ref={projector} aria-label="QR-код на проекторе">
      <button className="icon-button outline projector-close" aria-label="Закрыть показ" onClick={() => projector.current?.close()}><X size={24} /></button>
      <h2>{lesson.subject}</h2>
      <p>Группа {lesson.group_name} · до {session ? timeLabel(session.expires_at) : ''}</p>
      {image && <img alt="QR-код занятия для проектора" src={image} />}
      <div className="timer"><Clock3 size={22} />{countdown(remaining)}</div>
    </dialog>
  </section>
}
