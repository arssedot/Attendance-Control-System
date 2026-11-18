import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ActivityIndicator, Alert, AppState, Linking, Modal, Pressable, ScrollView,
  StatusBar, StyleSheet, Text, TextInput, View,
} from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { File } from 'expo-file-system'
import * as Location from 'expo-location'
import { decode } from 'jpeg-js'
import jsQR from 'jsqr'
import {
  ApiError, type HistoryMark, type Lesson, type Mark, type QrPreview, type User,
  attendanceQrToken, methodLabel, moscowDate, readPage, statusLabel, timeLabel,
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
      Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
        mayShowUserSettingsDialog: false,
      }).catch(() => {
        throw new Error('Не удалось получить геопозицию. Проверьте настройки телефона и повторите попытку.')
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Телефон не смог определить координаты. Повторите попытку.')), 15_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function locationProof() {
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
  return { latitude: coords.latitude, longitude: coords.longitude, horizontal_accuracy: coords.accuracy }
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
  const [cameraReady, setCameraReady] = useState(false)
  const [pictureSize, setPictureSize] = useState<string>()
  const [scanStatus, setScanStatus] = useState('')
  const [scanError, setScanError] = useState('')
  const [checkIn, setCheckIn] = useState<{ token: string; lesson: QrPreview } | null>(null)
  const [cameraPermission, requestCamera] = useCameraPermissions()
  const [foreground, setForeground] = useState(AppState.currentState === 'active')
  const camera = useRef<CameraView>(null)
  const scannerActive = useRef(false)
  const scanning = useRef(false)
  const scanPaused = useRef(false)
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
      scannerActive.current = true
      scanPaused.current = false
      setCameraReady(false)
      setScanError('')
      setCheckIn(null)
      setCameraOpen(true)
    })
  }

  function closeCamera() {
    if (scanning.current) return
    scannerActive.current = false
    setCameraOpen(false)
  }

  async function readQr(read: () => Promise<string | undefined>) {
    if (!scannerActive.current || scanning.current) return
    scanning.current = true
    scanPaused.current = false
    setScanError('')
    setScanStatus('Считываем QR-код…')
    try {
      const code = await read()
      if (!code) throw new Error('QR-код не считался. Поднесите камеру ближе и попробуйте снова.')
      const token = attendanceQrToken(code)
      if (!token) throw new Error('Это не QR-код Attendance. Сканируйте код с экрана преподавателя.')
      setScanStatus('QR-код считан. Проверяем занятие…')
      const lesson = await authorized<QrPreview>('/attendance/qr/preview', { method: 'POST', body: { token } })
      scannerActive.current = false
      setCheckIn({ token, lesson })
    } catch (cause) {
      scanPaused.current = true
      if (cause instanceof ApiError && cause.status === 401) onExpired(errorText(cause))
      else setScanError(errorText(cause))
    } finally {
      scanning.current = false
      setScanStatus('')
    }
  }

  async function confirmQr() {
    if (!checkIn || scanning.current) return
    scanning.current = true
    setScanError('')
    setScanStatus('Проверяем присутствие…')
    try {
      const point = await locationProof()
      const result = await authorized<Mark>('/attendance/qr', {
        method: 'POST', body: { token: checkIn.token, ...point },
      })
      setCameraOpen(false)
      saved(result)
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onExpired(errorText(cause))
      else setScanError(errorText(cause))
    } finally {
      scanning.current = false
      setScanStatus('')
    }
  }

  function onCameraReady() {
    setCameraReady(true)
    if (pictureSize) return
    void camera.current?.getAvailablePictureSizesAsync().then(sizes => {
      const supported = sizes.map(size => {
        const [width = 0, height = 0] = size.split('x').map(Number)
        return { size, pixels: width * height }
      }).filter(size => size.pixels > 0)
        .sort((a, b) => Math.abs(a.pixels - 1_200_000) - Math.abs(b.pixels - 1_200_000))
      setPictureSize(supported[0]?.size)
    }).catch(() => {})
  }

  async function decodeFrame(): Promise<string | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let ended = false
    let file: File | undefined
    async function captureAndRead() {
      const picture = await camera.current?.takePictureAsync({ shutterSound: false })
      if (!picture) throw new Error('Не удалось получить кадр с камеры.')
      file = new File(picture.uri)
      if (ended) {
        if (file.exists) file.delete()
        return
      }
      const bytes = await file.bytes()
      if (ended) return
      const frame = decode(bytes, { useTArray: true, maxResolutionInMP: 4, maxMemoryUsageInMB: 80 })
      return jsQR(new Uint8ClampedArray(frame.data), frame.width, frame.height, { inversionAttempts: 'dontInvert' })?.data
    }

    try {
      return await Promise.race([
        captureAndRead().catch(() => {
          throw new Error('Не удалось обработать кадр с камеры. Попробуйте сканировать снова.')
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Не удалось вовремя считать кадр. Попробуйте снова.')), 8_000)
        }),
      ])
    } finally {
      ended = true
      clearTimeout(timer)
      if (file?.exists) file.delete()
    }
  }

  function geo(lesson: Lesson) {
    return perform(async () => {
      const point = await locationProof()
      saved(await authorized<Mark>('/attendance/geo', {
        method: 'POST',
        body: { schedule_id: lesson.id, ...point },
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
          : lesson.session_state === 'ACTIVE' ? <>
            <Button secondary disabled={disabled} onPress={() => void geo(lesson)}>Отметиться по геолокации</Button>
            <Text style={styles.muted}>Координаты и погрешность сохранятся с отметкой. Их сможет увидеть преподаватель занятия.</Text>
          </>
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
    <Modal visible={cameraOpen} animationType="slide" onRequestClose={closeCamera}>
      <SafeAreaView style={styles.scanner}>
        {checkIn ? <ScrollView contentContainerStyle={styles.content}>
          <Text accessibilityRole="header" style={styles.title}>Подтверждение присутствия</Text>
          <View style={styles.card}>
            <Text style={styles.subject}>{checkIn.lesson.student_name}</Text>
            <Text style={styles.subject}>{checkIn.lesson.subject}</Text>
            <Text style={styles.muted}>{timeLabel(checkIn.lesson.starts_at)} · {checkIn.lesson.building_name} · ауд. {checkIn.lesson.room}</Text>
          </View>
          {checkIn.lesson.mark ? <Notice success>{`Отметка сохранена в ${timeLabel(checkIn.lesson.mark.created_at)} · ${statusLabel(checkIn.lesson.mark.status)}`}</Notice>
            : <>
              <Text style={styles.muted}>Приложение проверит, находится ли телефон в геозоне корпуса.</Text>
              <Button disabled={!!scanStatus} onPress={() => void confirmQr()}>
                {scanStatus || 'Подтвердить присутствие'}
              </Button>
            </>}
          {scanError ? <Notice>{scanError}</Notice> : null}
          <Button secondary disabled={!!scanStatus} onPress={closeCamera}>Закрыть</Button>
        </ScrollView> : <>
        <Text accessibilityRole="header" style={styles.title}>Сканирование QR</Text>
        <Text style={styles.muted}>Наведите камеру на экран преподавателя. Поместите весь QR-код в кадр.</Text>
        {cameraOpen && foreground ? <CameraView ref={camera} style={styles.camera} facing="back"
          pictureSize={pictureSize} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onCameraReady={onCameraReady}
          onBarcodeScanned={event => {
            if (!scanPaused.current) void readQr(async () => event.raw && event.raw !== 'null' ? event.raw : event.data)
          }} onMountError={() => {
            setCameraReady(false)
            setScanError('Не удалось запустить камеру. Проверьте разрешение и повторите попытку.')
          }} /> : <View style={styles.camera} />}
        {scanStatus ? <Text accessibilityLiveRegion="polite" style={styles.muted}>{scanStatus}</Text> : null}
        {scanError ? <Notice>{scanError}</Notice> : null}
        {scanError && cameraReady ? <Button secondary onPress={() => {
          scanPaused.current = false
          setScanError('')
        }}>Сканировать снова</Button> : null}
        <Button disabled={!cameraReady || !foreground || !!scanStatus} onPress={() => void readQr(decodeFrame)}>Считать с кадра</Button>
        <Button secondary disabled={!!scanStatus} onPress={closeCamera}>Закрыть камеру</Button>
        </>}
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
