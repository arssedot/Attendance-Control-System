import { ApiError, apiRequest, type AuthorizedRequest, type Tokens } from '@attendance/shared'

let accessToken: string | undefined
let pendingRefresh: Promise<Tokens> | undefined

async function serialized<T>(run: () => Promise<T>): Promise<T> {
  return navigator.locks ? await navigator.locks.request('attendance-auth', run) : run()
}

export function refresh(): Promise<Tokens> {
  pendingRefresh ??= serialized(async () => {
    const result = await apiRequest<Tokens>('', '/auth/refresh', { method: 'POST', body: {} })
    accessToken = result.access_token
    return result
  }).finally(() => { pendingRefresh = undefined })
  return pendingRefresh
}

export async function login(login: string, password: string): Promise<Tokens> {
  return serialized(async () => {
    const result = await apiRequest<Tokens>('', '/auth/login', {
      method: 'POST', body: { login, password, client: 'web' },
    })
    accessToken = result.access_token
    return result
  })
}

export async function logout(): Promise<void> {
  await serialized(async () => {
    await apiRequest('', '/auth/logout', { method: 'POST', body: {} })
    accessToken = undefined
  })
}

export const authorized: AuthorizedRequest = async (path, options) => {
  const previous = accessToken
  try {
    return await apiRequest('', path, { ...options, token: previous })
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error
    try {
      if (accessToken === previous) await refresh()
      return await apiRequest('', path, { ...options, token: accessToken })
    } catch (nextError) {
      if (nextError instanceof ApiError && nextError.status === 401) {
        accessToken = undefined
        window.dispatchEvent(new Event('attendance:expired'))
      }
      throw nextError
    }
  }
}
