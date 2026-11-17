import { useEffect, useState, type FormEvent } from 'react'
import { ArrowRight, Eye, EyeOff, Moon, ScanLine, Sun } from 'lucide-react'
import { ApiError, type User } from '@attendance/shared'
import { login, logout, refresh } from './auth'
import { Dashboard } from './Dashboard'

type Theme = 'system' | 'light' | 'dark'

export function Brand() {
  return <div className="brand"><span className="brand-icon"><ScanLine size={22} /></span>Attendance</div>
}

export function ErrorNotice({ message }: { message: string }) {
  return <div className="error-notice" role="alert">{message}</div>
}

export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : 'Операция не выполнена. Повторите попытку.'

export default function App() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem('attendance-theme')
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  })

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('attendance-theme', theme)
  }, [theme])

  useEffect(() => {
    const expired = () => {
      setUser(null)
      setMessage('Срок входа истёк. Войдите снова.')
    }
    window.addEventListener('attendance:expired', expired)
    void refresh().then(tokens => setUser(tokens.user)).catch((error: unknown) => {
      if (!(error instanceof ApiError) || error.status !== 401) setMessage(messageOf(error))
    }).finally(() => setLoading(false))
    return () => window.removeEventListener('attendance:expired', expired)
  }, [])

  const themeControl = <label className="theme-control" title="Оформление">
    {theme === 'dark' ? <Moon size={16} /> : <Sun size={16} />}
    <select aria-label="Оформление" value={theme} onChange={event => setTheme(event.target.value as Theme)}>
      <option value="system">Системная</option>
      <option value="light">Светлая</option>
      <option value="dark">Тёмная</option>
    </select>
  </label>

  if (loading) return <main className="boot" aria-busy="true"><Brand /><p>Подключение…</p></main>
  if (user) return <Dashboard key={user.id} user={user} themeControl={themeControl} onLogout={async () => {
    await logout()
    setUser(null)
  }} />
  return <LoginPage initialMessage={message} themeControl={themeControl} onLogin={setUser} />
}

function LoginPage({ initialMessage, themeControl, onLogin }: {
  initialMessage: string
  themeControl: React.ReactNode
  onLogin: (user: User) => void
}) {
  const [busy, setBusy] = useState(false)
  const [visible, setVisible] = useState(false)
  const [error, setError] = useState(initialMessage)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setBusy(true)
    setError('')
    try {
      onLogin((await login(String(form.get('login')), String(form.get('password')))).user)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  return <div className="login-page">
    <header className="login-header"><Brand />{themeControl}</header>
    <main className="login-main">
      <form className="panel login-card" onSubmit={submit}>
        <span className="login-symbol"><ScanLine size={28} /></span>
        <h1>Вход в кабинет</h1>
        <p className="muted">Управляйте регистрацией и просматривайте посещаемость своих занятий.</p>
        <label className="field">Логин
          <input name="login" autoComplete="username" placeholder="Введите логин" required maxLength={254} />
        </label>
        <label className="field">Пароль
          <span className="password-field">
            <input name="password" type={visible ? 'text' : 'password'} autoComplete="current-password"
              placeholder="Введите пароль" required maxLength={256} />
            <button className="icon-button" type="button" aria-label={visible ? 'Скрыть пароль' : 'Показать пароль'}
              onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button>
          </span>
        </label>
        {error && <ErrorNotice message={error} />}
        <button className="button primary" disabled={busy}>
          {busy ? 'Входим…' : 'Войти'}<ArrowRight size={18} />
        </button>
      </form>
    </main>
    <footer className="login-footer">Система учёта посещаемости</footer>
  </div>
}
