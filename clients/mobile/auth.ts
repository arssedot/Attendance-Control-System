import * as SecureStore from 'expo-secure-store'
import { ApiError, apiRequest, type AuthorizedRequest, type Tokens } from '@attendance/shared'

const STORE_KEY = 'attendance.refresh.v1'
let accessToken: string | undefined
let refreshing: Promise<Tokens | null> | undefined

function endpoint() {
  const value = process.env.EXPO_PUBLIC_API_URL?.trim()
  if (!value || !/^https:\/\/(?:[a-z0-9.-]+|\[[a-f0-9:]+\])(?::\d{1,5})?\/?$/i.test(value)) {
    throw new ApiError(0, 'CONFIGURATION_ERROR', 'Для приложения требуется HTTPS-адрес сервера Attendance.')
  }
  return value.replace(/\/$/, '')
}

async function remember(result: Tokens) {
  if (!result.refresh_token || result.user.role !== 'ROLE_STUDENT') {
    throw new ApiError(403, 'CLIENT_FORBIDDEN', 'Мобильное приложение предназначено для студентов.')
  }
  await SecureStore.setItemAsync(STORE_KEY, result.refresh_token)
  accessToken = result.access_token
  return result
}

export async function signIn(login: string, password: string) {
  return remember(await apiRequest<Tokens>(endpoint(), '/auth/login', {
    method: 'POST', body: { login, password, client: 'mobile' },
  }))
}

export function restore(): Promise<Tokens | null> {
  refreshing ??= (async () => {
    const refresh_token = await SecureStore.getItemAsync(STORE_KEY)
    if (!refresh_token) return null
    try {
      return await remember(await apiRequest<Tokens>(endpoint(), '/auth/refresh', {
        method: 'POST', body: { refresh_token },
      }))
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error
      await SecureStore.deleteItemAsync(STORE_KEY)
      accessToken = undefined
      return null
    }
  })().finally(() => { refreshing = undefined })
  return refreshing
}

export async function signOut() {
  await refreshing?.catch(() => null)
  const refresh_token = await SecureStore.getItemAsync(STORE_KEY)
  if (refresh_token) {
    await apiRequest(endpoint(), '/auth/logout', { method: 'POST', body: { refresh_token } })
  }
  await SecureStore.deleteItemAsync(STORE_KEY)
  accessToken = undefined
}

export const authorized: AuthorizedRequest = async (path, options) => {
  const previous = accessToken
  try {
    return await apiRequest(endpoint(), path, { ...options, token: previous })
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error
    if (accessToken === previous && !(await restore())) {
      throw new ApiError(401, 'UNAUTHENTICATED', 'Срок входа истёк. Войдите снова.')
    }
    return apiRequest(endpoint(), path, { ...options, token: accessToken })
  }
}
