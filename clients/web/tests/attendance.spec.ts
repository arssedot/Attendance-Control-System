import { expect, test, type APIRequestContext } from '@playwright/test'
import jsQR from 'jsqr'
import type { Lesson, Tokens } from '@attendance/shared'

const password = process.env.DEMO_PASSWORD
const api = '/api/v1'

async function student(request: APIRequestContext, login: string) {
  const response = await request.post(`${api}/auth/login`, { data: { login, password, client: 'mobile' } })
  expect(response.status()).toBe(200)
  return { Authorization: `Bearer ${((await response.json()) as Tokens).access_token}` }
}

test('преподаватель открывает QR, студенты отмечаются двумя способами, список обновляется', async ({ page, request }) => {
  expect(password, 'Set DEMO_PASSWORD for the dedicated QA instance').toBeTruthy()
  await page.goto('/')
  await page.getByLabel('Логин').fill('teacher')
  await page.getByLabel('Пароль', { exact: true }).fill(password!)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Расписание', exact: true })).toBeVisible()
  await page.getByRole('button', { name: /Объектно-ориентированное проектирование/ }).click()
  await page.getByRole('button', { name: 'Открыть регистрацию' }).click()
  await page.getByRole('button', { name: 'На экран' }).click()
  const image = page.getByRole('img', { name: 'QR-код занятия для проектора' })
  await expect(image).toBeVisible()
  const pixels = await image.evaluate(async (element: HTMLImageElement) => {
    await element.decode()
    const canvas = document.createElement('canvas')
    canvas.width = element.naturalWidth
    canvas.height = element.naturalHeight
    const context = canvas.getContext('2d')!
    context.drawImage(element, 0, 0)
    return { bytes: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data),
      width: canvas.width, height: canvas.height }
  })
  const code = jsQR(Uint8ClampedArray.from(pixels.bytes), pixels.width, pixels.height)
  expect(code?.data).toBeTruthy()
  await page.getByRole('button', { name: 'Закрыть показ' }).click()

  const qrStudent = await student(request, 'student')
  const qr = await request.post(`${api}/attendance/qr`, { headers: qrStudent, data: { token: code!.data } })
  expect(qr.status()).toBe(200)
  expect((await qr.json()).method).toBe('QR')
  const geoStudent = await student(request, 'student2')
  const schedule = await request.get(`${api}/schedule`, { headers: geoStudent })
  expect(schedule.status()).toBe(200)
  const active = ((await schedule.json()) as Lesson[]).find(lesson => lesson.session_state === 'ACTIVE')
  expect(active).toBeTruthy()
  const geo = await request.post(`${api}/attendance/geo`, {
    headers: geoStudent, data: {
      schedule_id: active!.id, latitude: 56.2955, longitude: 43.9833, horizontal_accuracy: 8,
    },
  })
  expect(geo.status()).toBe(200)
  expect((await geo.json()).method).toBe('GEO')
  await page.getByRole('button', { name: 'Обновить', exact: true }).click()
  await expect(page.getByRole('row', { name: /Илья Соколов.*QR-код/ })).toBeVisible()
  await expect(page.getByRole('row', { name: /Мария Новикова.*Геолокация/ })).toBeVisible()
  if (process.env.QA_SCREENSHOTS) {
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({ path: 'test-results/attendance-desktop.png', fullPage: true })
  }
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  if (process.env.QA_SCREENSHOTS) {
    await page.screenshot({ path: 'test-results/attendance-mobile-web.png', fullPage: true })
  }
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.getByLabel('Регистрация, мин.').fill('15')
  await page.getByRole('button', { name: 'Обновить срок и QR-код' }).click()
  await expect(page.getByRole('button', { name: 'Обновить срок и QR-код' })).toBeEnabled()
  await page.getByRole('button', { name: 'Завершить регистрацию' }).click()
  await page.getByRole('button', { name: 'Подтвердить завершение' }).click()
  await expect(page.getByText('Регистрация завершена.')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Расписание', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Выйти' }).click()
  await expect(page.getByRole('heading', { name: 'Вход в кабинет' })).toBeVisible()
})
