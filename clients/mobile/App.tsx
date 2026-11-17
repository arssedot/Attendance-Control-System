import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ActivityIndicator, Alert, AppState, Linking, Modal, Pressable, ScrollView,
  StatusBar, StyleSheet, Text, TextInput, View,
} from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { CameraView, useCameraPermissions } from 'expo-camera'
import * as Location from 'expo-location'
import {
  ApiError, type HistoryMark, type Lesson, type Mark, type User,
  methodLabel, moscowDate, readPage, statusLabel, timeLabel,
} from '@attendance/shared'
import { authorized, restore, signIn, signOut } from './auth'

const colors = {
  background: '#f7f7fb', white: '#ffffff', text: '#222138', muted: '#5c5a70',
  line: '#e6e4f0', accent: '#5b42c0', accentSoft: '#eee9ff',
  success: '#12614b', successSoft: '#dbf4e9', error: '#9a2940', errorSoft: '#fff0f3',
}
const dayFormat = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', weekday: 'long',
})
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'Операция не выполнена. Повторите попытку.'

function Button({ children, onPress, disabled, secondary = false }: {
  children: string
  onPress: () => void
  disabled?: boolean
  secondary?: boolean
}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} onPress={onPress}
    disabled={disabled} style={({ pressed }) => [
      styles.button, secondary && styles.secondary, (pressed || disabled) && styles.dimmed,
    ]}>
    <Text style={[styles.buttonText, secondary && styles.secondaryText]}>{children}</Text>
  </Pressable>
}

function Notice({ children, success = false }: { children: ReactNode; success?: boolean }) {
  return <View style={[styles.notice, success && styles.noticeSuccess]}>
    <Text accessibilityRole="alert" accessibilityLiveRegion="polite"
      style={[styles.noticeText, success && styles.noticeSuccessText]}>{children}</Text>
  </View>
}

export default function App() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(false)

  useEffect(() => {
    let mounted = true
    void restore().then(result => { if (mounted && result) setUser(result.user) })
      .catch(cause => {
        if (mounted) {
          setError(errorText(cause))
          setRetry(true)
        }
      }).finally(() => { if (mounted) setLoading(false) })
    return () => { mounted = false }
  }, [])

  async function restoreManually() {
    setError('')
    setLoading(true)
    try {
      const result = await restore()
      setUser(result?.user ?? null)
      setRetry(false)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setLoading(false)
    }
  }

  return <SafeAreaProvider>
    <StatusBar barStyle="dark-content" />
    <SafeAreaView style={styles.container}>
      {loading ? <View style={styles.center}><ActivityIndicator color={colors.accent} /><Text>Подключение…</Text></View>
        : user ? <StudentHome user={user} onExpired={(message) => {
          setError(message)
          setUser(null)
        }} onLogout={async () => {
          await signOut()
          setError('')
          setUser(null)
        }} /> : <LoginForm error={error} retry={retry ? () => void restoreManually() : undefined}
          onUser={next => { setError(''); setRetry(false); setUser(next) }} />}
    </SafeAreaView>
  </SafeAreaProvider>
}

function LoginForm({ error, retry, onUser }: { error: string; retry?: () => void; onUser: (user: User) => void }) {
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState(error)
  const submitting = useRef(false)

  async function submit() {
    if (submitting.current || !login.trim() || !password) return
    submitting.current = true
    setBusy(true)
    setFailure('')
    try {
      onUser((await signIn(login, password)).user)
    } catch (cause) {
      setFailure(errorText(cause))
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  return <ScrollView contentContainerStyle={styles.login} keyboardShouldPersistTaps="handled">
    <Text style={styles.brand}>Attendance</Text>
    <View style={styles.card}>
      <Text accessibilityRole="header" style={styles.title}>Вход студента</Text>
      <Text style={styles.muted}>Отмечайтесь на занятиях по QR-коду или геолокации.</Text>
      <Text style={styles.label}>Логин</Text>
      <TextInput accessibilityLabel="Логин" style={styles.input} value={login} onChangeText={setLogin}
        autoCapitalize="none" autoCorrect={false} autoComplete="username" maxLength={254} editable={!busy} />
      <Text style={styles.label}>Пароль</Text>
      <TextInput accessibilityLabel="Пароль" style={styles.input} value={password} onChangeText={setPassword}
        secureTextEntry autoComplete="current-password" onSubmitEditing={() => void submit()} maxLength={256} editable={!busy} />
      {failure ? <Notice>{failure}</Notice> : null}
      {retry && failure ? <Button secondary onPress={retry}>Восстановить вход</Button> : null}
      <Button disabled={busy || !login.trim() || !password} onPress={() => void submit()}>{busy ? 'Входим…' : 'Войти'}</Button>
    </View>
  </ScrollView>
}

function settingsPrompt(resource: string) {
  Alert.alert('Требуется разрешение', `Разрешите доступ к ${resource} в настройках телефона.`, [
    { text: 'Закрыть', style: 'cancel' },
    { text: 'Настройки', onPress: () => void Linking.openSettings().catch(() => {}) },
  ])
}

async function currentLocation() {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Телефон не смог определить координаты. Повторите попытку.')), 15_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function StudentHome({ user, onLogout, onExpired }: {
  user: User
  onLogout: () => Promise<void>
  onExpired: (message: string) => void
}) {
  const [screen, setScreen] = useState<'schedule' | 'history'>('schedule')
  const [day, setDay] = useState(moscowDate)
  const [lessons, setLessons] = useState<Lesson[]>([])
  const [records, setRecords] = useState<HistoryMark[]>([])
  const [loaded, setLoaded] = useState(false)
  const [more, setMore] = useState(false)
  const [version, setVersion] = useState(0)
  const [error, setError] = useState('')
  const [loadingMore, setLoadingMore] = useState(false)
  const [mark, setMark] = useState<Mark | null>(null)
  const [busy, setBusy] = useState(false)
  const [cameraOpen, setCameraOpen] = useState(false)
  const [cameraPermission, requestCamera] = useCameraPermissions()
  const [foreground, setForeground] = useState(AppState.currentState === 'active')
  const scanning = useRef(false)
  const running = useRef(false)
  const expiredCallback = useRef(onExpired)
  expiredCallback.current = onExpired
  const path = screen === 'schedule' ? `/schedule?date=${day}` : '/student/attendance'

  useEffect(() => {
    const listener = AppState.addEventListener('change', next => setForeground(next === 'active'))
    return () => listener.remove()
  }, [])

  useEffect(() => {
    let mounted = true
    setLoaded(false)
    setMore(false)
    const request = screen === 'schedule'
      ? readPage<Lesson>(authorized, path).then(data => { if (mounted) setLessons(data); return data })
      : readPage<HistoryMark>(authorized, path).then(data => { if (mounted) setRecords(data); return data })
    void request.then(data => { if (mounted) setMore(data.length === 50) })
      .catch(cause => {
        if (!mounted) return
        if (cause instanceof ApiError && cause.status === 401) expiredCallback.current(errorText(cause))
        else {
          setError(errorText(cause))
          setLessons([])
          setRecords([])
        }
      }).finally(() => { if (mounted) setLoaded(true) })
    return () => { mounted = false }
  }, [screen, path, version])

  function resetPage() {
    setError('')
    setMark(null)
  }

  function moveDay(delta: number) {
    const value = new Date(`${day}T12:00:00Z`)
    value.setUTCDate(value.getUTCDate() + delta)
    resetPage()
    setDay(moscowDate(value))
  }

  function showError(cause: unknown) {
    if (cause instanceof ApiError && cause.status === 401) onExpired(errorText(cause))
    else setError(errorText(cause))
  }

  async function perform(task: () => Promise<void>) {
    if (running.current) return
    running.current = true
    setBusy(true)
    resetPage()
    try {
      await task()
    } catch (cause) {
      showError(cause)
    } finally {
      running.current = false
      setBusy(false)
    }
  }

  function saved(result: Mark) {
    setMark(result)
    setVersion(current => current + 1)
  }

  function openCamera() {
    return perform(async () => {
      const permission = cameraPermission?.granted ? cameraPermission : await requestCamera()
      if (!permission.granted) {
        if (!permission.canAskAgain) settingsPrompt('камере')
        throw new Error('Для сканирования разрешите доступ к камере.')
      }
      scanning.current = false
      setCameraOpen(true)
    })
  }

  function scan(token: string) {
    if (scanning.current) return
    scanning.current = true
    setCameraOpen(false)
    void perform(async () => saved(await authorized<Mark>('/attendance/qr', {
      method: 'POST', body: { token },
    })))
  }

  function geo(lesson: Lesson) {
    return perform(async () => {
      const permission = await Location.requestForegroundPermissionsAsync()
      if (!permission.granted) {
        if (!permission.canAskAgain) settingsPrompt('геолокации')
        throw new Error('Для отметки разрешите доступ к геолокации.')
      }
      if (!(await Location.hasServicesEnabledAsync())) throw new Error('Включите геолокацию в настройках телефона.')
      const { coords } = await currentLocation()
      if (coords.accuracy === null || coords.accuracy <= 0) {
        throw new Error('Телефон не сообщил точность координат. Повторите попытку.')
      }
      saved(await authorized<Mark>('/attendance/geo', {
        method: 'POST',
        body: {
          schedule_id: lesson.id, latitude: coords.latitude, longitude: coords.longitude,
          horizontal_accuracy: coords.accuracy,
        },
      }))
    })
  }

  async function loadMore() {
    setError('')
    setLoadingMore(true)
    try {
      if (screen === 'schedule') {
        const data = await readPage<Lesson>(authorized, path, lessons.length)
        setLessons(current => [...current, ...data])
        setMore(data.length === 50)
      } else {
        const data = await readPage<HistoryMark>(authorized, path, records.length)
        setRecords(current => [...current, ...data])
        setMore(data.length === 50)
      }
    } catch (cause) {
      showError(cause)
    } finally {
      setLoadingMore(false)
    }
  }

  const disabled = busy || loadingMore
  const openSchedule = () => { resetPage(); setScreen('schedule') }
  const openHistory = () => { resetPage(); setScreen('history') }

  return <>
    <View style={styles.topbar}>
      <View style={styles.flex}><Text style={styles.brand}>Attendance</Text><Text style={styles.muted}>{user.display_name}</Text></View>
      <Button secondary disabled={disabled} onPress={() => void perform(onLogout)}>Выйти</Button>
    </View>
    <View style={styles.tabs}>
      <View style={styles.flex}><Button secondary={screen !== 'schedule'} disabled={disabled} onPress={openSchedule}>Расписание</Button></View>
      <View style={styles.flex}><Button secondary={screen !== 'history'} disabled={disabled} onPress={openHistory}>История</Button></View>
    </View>
    <ScrollView contentContainerStyle={styles.content}>
      {screen === 'schedule' ? <>
        <Text accessibilityRole="header" style={styles.title}>Мои занятия</Text>
        <View style={styles.dateRow}>
          <Pressable accessibilityRole="button" accessibilityLabel="Предыдущий день" disabled={disabled}
            onPress={() => moveDay(-1)} style={styles.dateButton}><Text style={styles.dateArrow}>‹</Text></Pressable>
          <Text style={styles.date}>{dayFormat.format(new Date(`${day}T12:00:00Z`))}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Следующий день" disabled={disabled}
            onPress={() => moveDay(1)} style={styles.dateButton}><Text style={styles.dateArrow}>›</Text></Pressable>
        </View>
        <Button disabled={disabled} onPress={() => void openCamera()}>Сканировать QR-код</Button>
      </> : <Text accessibilityRole="header" style={styles.title}>История отметок</Text>}
      {error ? <Notice>{error}</Notice> : null}
      {mark ? <Notice success>{`Отметка сохранена в ${timeLabel(mark.created_at)} · ${statusLabel(mark.status)}`}</Notice> : null}
      {loaded ? <Button secondary disabled={disabled} onPress={() => { resetPage(); setVersion(value => value + 1) }}>Обновить список</Button>
        : <ActivityIndicator accessibilityLabel="Загрузка" color={colors.accent} />}
      {loaded && screen === 'schedule' && lessons.map(lesson => <View key={lesson.id} style={styles.card}>
        <Text style={styles.lessonTime}>{timeLabel(lesson.starts_at)}–{timeLabel(lesson.ends_at)}</Text>
        <Text style={styles.subject}>{lesson.subject}</Text>
        <Text style={styles.muted}>{lesson.building_name} · ауд. {lesson.room}</Text>
        <Text style={styles.muted}>{lesson.teacher_name}</Text>
        {lesson.marked ? <Text style={styles.marked}>Отметка сохранена</Text>
          : lesson.session_state === 'ACTIVE' ? <Button secondary disabled={disabled} onPress={() => void geo(lesson)}>Отметиться по геолокации</Button>
            : <Text style={styles.muted}>{lesson.session_state ? 'Регистрация завершена' : 'Регистрация ещё не открыта'}</Text>}
      </View>)}
      {loaded && screen === 'history' && records.map(record => <View key={record.session_id} style={styles.card}>
        <Text style={styles.lessonTime}>{dayFormat.format(new Date(record.starts_at))}</Text>
        <Text style={styles.subject}>{record.subject}</Text>
        <Text style={styles.muted}>{timeLabel(record.created_at)} · {methodLabel(record.method)}</Text>
        <Text style={styles.marked}>{statusLabel(record.status)}</Text>
      </View>)}
      {loaded && !error && (screen === 'schedule' ? !lessons.length : !records.length)
        ? <Text style={styles.muted}>{screen === 'schedule' ? 'На этот день занятий нет.' : 'Сохранённых отметок пока нет.'}</Text> : null}
      {loaded && more ? <Button secondary disabled={disabled} onPress={() => void loadMore()}>Показать ещё</Button> : null}
    </ScrollView>
    <Modal visible={cameraOpen} animationType="slide" onRequestClose={() => setCameraOpen(false)}>
      <SafeAreaView style={styles.scanner}>
        <Text accessibilityRole="header" style={styles.title}>Сканирование QR</Text>
        <Text style={styles.muted}>Наведите камеру на код на экране преподавателя.</Text>
        {cameraOpen && foreground ? <CameraView style={styles.camera} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={event => scan(event.data)} onMountError={() => {
            setCameraOpen(false)
            setError('Не удалось запустить камеру. Проверьте разрешение и повторите попытку.')
          }} /> : <View style={styles.camera} />}
        <Button secondary onPress={() => setCameraOpen(false)}>Закрыть камеру</Button>
      </SafeAreaView>
    </Modal>
  </>
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },
  login: { flexGrow: 1, justifyContent: 'center', gap: 22, padding: 20 },
  content: { padding: 16, gap: 12 },
  brand: { color: colors.accent, fontSize: 22, fontWeight: '800', letterSpacing: -0.6 },
  title: { color: colors.text, fontSize: 25, fontWeight: '800', letterSpacing: -0.7 },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  card: { backgroundColor: colors.white, borderColor: colors.line, borderWidth: 1, borderRadius: 16, padding: 16, gap: 9 },
  label: { color: colors.text, fontWeight: '700' },
  input: { minHeight: 48, borderRadius: 9, borderColor: colors.line, borderWidth: 1, padding: 10, color: colors.text },
  button: { minHeight: 48, paddingHorizontal: 12, paddingVertical: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent, borderRadius: 10 },
  buttonText: { color: colors.white, fontSize: 15, fontWeight: '700', textAlign: 'center' },
  secondary: { backgroundColor: colors.accentSoft },
  secondaryText: { color: colors.accent },
  dimmed: { opacity: 0.6 },
  notice: { backgroundColor: colors.errorSoft, padding: 12, borderRadius: 10 },
  noticeText: { color: colors.error, fontSize: 14, lineHeight: 20 },
  noticeSuccess: { backgroundColor: colors.successSoft },
  noticeSuccessText: { color: colors.success },
  topbar: { padding: 16, flexDirection: 'row', alignItems: 'center', gap: 10 },
  tabs: { flexDirection: 'row', gap: 8, paddingHorizontal: 16 },
  dateRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 5 },
  date: { flex: 1, textAlign: 'center', color: colors.muted, fontSize: 14, fontWeight: '600' },
  dateButton: { minWidth: 45, minHeight: 45, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: colors.white },
  dateArrow: { color: colors.accent, fontSize: 24, fontWeight: '700' },
  flex: { flex: 1 },
  lessonTime: { color: colors.accent, fontSize: 14, fontWeight: '700' },
  subject: { color: colors.text, fontSize: 17, fontWeight: '700' },
  marked: { color: colors.success, fontSize: 14, fontWeight: '700' },
  scanner: { flex: 1, backgroundColor: colors.background, padding: 16, gap: 12 },
  camera: { flex: 1, backgroundColor: '#222138', borderRadius: 14, overflow: 'hidden' },
})
