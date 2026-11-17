import { useEffect, useState, type ReactNode } from 'react'
import {
  CalendarDays, ChevronLeft, ChevronRight, ClipboardList, Clock3, LogOut,
  MapPin, RefreshCw, ScanLine, Users,
} from 'lucide-react'
import {
  type Lesson, type RosterMark, type Session, type User, methodLabel, moscowDate, readPage, statusLabel, timeLabel,
} from '@attendance/shared'
import { Brand, ErrorNotice, messageOf } from './App'
import { authorized } from './auth'
import { SessionPanel } from './SessionPanel'

const sessionLabels = { ACTIVE: 'Регистрация открыта', EXPIRED: 'Срок истёк', CLOSED: 'Завершено' } as const
const dayFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric', month: 'long', weekday: 'long', timeZone: 'Europe/Moscow',
})

const currentDay = (day: string) => new Date(`${day}T12:00:00Z`)
const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(word => word[0]).join('')

function LessonList({ lessons, selected, onSelect }: {
  lessons: Lesson[]
  selected: string | null
  onSelect: (id: string) => void
}) {
  return <ul className="lesson-list">{lessons.map(lesson =>
    <li key={lesson.id}>
      <button className={`lesson ${selected === lesson.id ? 'chosen' : ''}`} aria-pressed={selected === lesson.id}
        onClick={() => onSelect(lesson.id)}>
        <div className="lesson-time"><strong>{timeLabel(lesson.starts_at)}</strong><span>{timeLabel(lesson.ends_at)}</span></div>
        <div className="lesson-body">
          <strong>{lesson.subject}</strong>
          <span className="lesson-meta"><Users size={14} />{lesson.group_name}<span>·</span><MapPin size={14} />Ауд. {lesson.room}</span>
        </div>
        <span className={`badge ${lesson.session_state === 'ACTIVE' ? 'positive' : ''}`}>
          {lesson.session_state ? sessionLabels[lesson.session_state] : 'По расписанию'}
        </span>
        <ChevronRight className="lesson-chevron" size={19} />
      </button>
    </li>)}</ul>
}

export function Dashboard({ user, themeControl, onLogout }: {
  user: User
  themeControl: ReactNode
  onLogout: () => Promise<void>
}) {
  const [tab, setTab] = useState<'schedule' | 'attendance'>('schedule')
  const [day, setDay] = useState(moscowDate)
  const [lessons, setLessons] = useState<Lesson[]>([])
  const [selection, setSelection] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [logoutBusy, setLogoutBusy] = useState(false)

  useEffect(() => {
    let ignore = false
    setLoaded(false)
    setError('')
    void readPage<Lesson>(authorized, `/schedule?date=${day}`).then(data => {
      if (ignore) return
      setLessons(data)
      setHasMore(data.length === 50)
      setSelection(id => data.some(lesson => lesson.id === id) ? id : data[0]?.id ?? null)
    }).catch(cause => {
      if (!ignore) {
        setError(messageOf(cause))
        setLessons([])
      }
    }).finally(() => { if (!ignore) setLoaded(true) })
    return () => { ignore = true }
  }, [day, reload])

  const visible = tab === 'schedule' ? lessons : lessons.filter(lesson => lesson.session_id)
  const lesson = visible.find(item => item.id === selection) ?? visible[0]
  const offsetDay = (delta: number) => {
    const next = currentDay(day)
    next.setUTCDate(next.getUTCDate() + delta)
    setDay(moscowDate(next))
  }
  const updateSession = (session: Session) => setLessons(data => data.map(item =>
    item.id === session.schedule_id ? { ...item, session_id: session.id, session_state: session.state } : item,
  ))

  async function loadMore() {
    setBusy(true)
    setError('')
    try {
      const next = await readPage<Lesson>(authorized, `/schedule?date=${day}`, lessons.length)
      setLessons(data => [...data, ...next])
      setHasMore(next.length === 50)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  async function signOut() {
    setLogoutBusy(true)
    try {
      await onLogout()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setLogoutBusy(false)
    }
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <Brand />
      <nav aria-label="Кабинет преподавателя">
        <button className={tab === 'schedule' ? 'nav-item active' : 'nav-item'} aria-current={tab === 'schedule' ? 'page' : undefined}
          onClick={() => setTab('schedule')}><CalendarDays size={19} />Расписание</button>
        <button className={tab === 'attendance' ? 'nav-item active' : 'nav-item'} aria-current={tab === 'attendance' ? 'page' : undefined}
          onClick={() => setTab('attendance')}><ClipboardList size={19} />Посещаемость</button>
      </nav>
      <div className="sidebar-footer">
        <button className="nav-item" onClick={() => void signOut()} disabled={logoutBusy}><LogOut size={19} />Выйти</button>
      </div>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <span className="topbar-label">Кабинет преподавателя</span>
        <div className="topbar-actions">{themeControl}
          <span className="user-name">{user.display_name}</span><span className="avatar" aria-hidden="true">{initials(user.display_name)}</span>
        </div>
      </header>
      <main className="content">
        <div className="page-heading">
          <div>
            <h1>{tab === 'schedule' ? 'Расписание' : 'Посещаемость'}</h1>
            <p>{tab === 'schedule' ? 'Открывайте регистрацию на занятия и показывайте QR-код группе.' : 'Выберите занятие, чтобы посмотреть сохранённые отметки.'}</p>
          </div>
          <div className="date-controls">
            <button className="icon-button outline" onClick={() => offsetDay(-1)} disabled={busy} aria-label="Предыдущий день"><ChevronLeft size={18} /></button>
            <input type="date" aria-label="Дата занятий" value={day} disabled={busy} min="1970-01-01" max="9998-12-31"
              onChange={event => { if (event.target.value && event.target.validity.valid) setDay(event.target.value) }} />
            <button className="icon-button outline" onClick={() => offsetDay(1)} disabled={busy} aria-label="Следующий день"><ChevronRight size={18} /></button>
            <button className="button secondary" onClick={() => setDay(moscowDate())} disabled={busy || day === moscowDate()}>Сегодня</button>
          </div>
        </div>
        {error && <ErrorNotice message={error} />}
        <div className="dashboard-grid">
          <section className="panel schedule-panel" aria-label="Занятия за выбранный день" aria-busy={!loaded}>
            <div className="panel-heading">
              <div className="heading-icon"><CalendarDays size={20} /></div>
              <div><h2>Занятия</h2><p>{dayFormatter.format(currentDay(day))}</p></div>
              <button className="icon-button outline end" onClick={() => setReload(value => value + 1)} disabled={!loaded || busy}
                aria-label="Обновить расписание"><RefreshCw size={17} /></button>
            </div>
            {!loaded ? <p className="empty-inline">Загружаем расписание…</p> : visible.length ? (
              <LessonList lessons={visible} selected={lesson?.id ?? null} onSelect={setSelection} />
            ) : <div className="empty-state"><CalendarDays size={30} /><h3>{tab === 'schedule' ? 'Занятий нет' : 'Сессий пока нет'}</h3>
              <p>Выберите другую дату.</p></div>}
            {loaded && hasMore && <button className="button secondary more" disabled={busy} onClick={() => void loadMore()}>Ещё занятия</button>}
          </section>
          {loaded && lesson && tab === 'schedule'
            ? <SessionPanel key={lesson.id} lesson={lesson} onUpdate={updateSession} />
            : loaded && lesson?.session_id
              ? <div className="side-panel"><Roster key={lesson.session_id} sessionId={lesson.session_id} /></div>
              : <section className="panel empty-state side-panel"><ScanLine size={30} /><h2>Сессия занятия</h2><p>Выберите занятие в расписании.</p></section>}
          {loaded && lesson?.session_id && tab === 'schedule' && <Roster key={lesson.session_id} sessionId={lesson.session_id} />}
        </div>
        <footer className="dashboard-footer"><Clock3 size={14} />Московское время</footer>
      </main>
    </div>
  </div>
}

function Roster({ sessionId }: { sessionId: string }) {
  const [rows, setRows] = useState<RosterMark[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)
  const [hasMore, setHasMore] = useState(false)
  const [revision, setRevision] = useState(0)
  const path = `/sessions/${sessionId}/attendance`

  useEffect(() => {
    let ignore = false
    setBusy(true)
    setError('')
    void readPage<RosterMark>(authorized, path).then(data => {
      if (ignore) return
      setRows(data)
      setHasMore(data.length === 50)
    }).catch(cause => { if (!ignore) setError(messageOf(cause)) })
      .finally(() => { if (!ignore) setBusy(false) })
    return () => { ignore = true }
  }, [path, revision])

  async function loadMore() {
    setBusy(true)
    setError('')
    try {
      const next = await readPage<RosterMark>(authorized, path, rows.length)
      setRows(data => [...data, ...next])
      setHasMore(next.length === 50)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  return <section className="panel roster" aria-busy={busy}>
    <div className="panel-heading">
      <div className="heading-icon"><ClipboardList size={20} /></div>
      <div><h2>Отметки студентов</h2><p>{busy ? 'Обновляем список…' : `В списке: ${rows.length}`}</p></div>
      <button className="button secondary end" disabled={busy} onClick={() => setRevision(value => value + 1)}><RefreshCw size={16} />Обновить</button>
    </div>
    {error && <ErrorNotice message={error} />}
    {rows.length > 0 ? <div className="table-scroll"><table aria-label="Отметки студентов">
      <thead><tr><th>Студент</th><th>Время</th><th>Способ</th><th>Статус</th></tr></thead>
      <tbody>{rows.map((row, index) => <tr key={`${row.created_at}-${row.student_name}-${index}`}>
        <td>{row.student_name}</td><td>{timeLabel(row.created_at)}</td><td>{methodLabel(row.method)}</td>
        <td><span className={`badge ${row.status === 'PRESENT' ? 'positive' : 'warning'}`}>{statusLabel(row.status)}</span></td>
      </tr>)}</tbody>
    </table></div> : !busy && !error && <p className="empty-inline">Студенты ещё не отметились.</p>}
    {hasMore && <button className="button secondary more" onClick={() => void loadMore()} disabled={busy}>Ещё отметки</button>}
  </section>
}
