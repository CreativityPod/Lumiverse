import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

// Exercise the actual worker event handler; caching is unrelated to push.
mock.module('workbox-precaching', () => ({
  precacheAndRoute() {}, cleanupOutdatedCaches() {}, createHandlerBoundToURL() {},
}))
mock.module('workbox-routing', () => ({ registerRoute() {}, NavigationRoute: class {} }))
mock.module('workbox-strategies', () => ({ CacheFirst: class {}, NetworkFirst: class {}, NetworkOnly: class {} }))
mock.module('workbox-expiration', () => ({ ExpirationPlugin: class {} }))
mock.module('workbox-background-sync', () => ({ BackgroundSyncPlugin: class {} }))

const originalSelf = globalThis.self
const handlers = new Map<string, (event: any) => void>()
const matchAll = mock(async (): Promise<any[]> => [])
const showNotification = mock(async (_title: string, _options: NotificationOptions) => {})
const getNotifications = mock(async (): Promise<any[]> => [{}])
const setAppBadge = mock(async (_count: number) => {})

;(globalThis as any).self = {
  addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
  clients: { matchAll },
  registration: { showNotification, getNotifications },
  navigator: { setAppBadge },
}
await import('./sw')

afterAll(() => {
  if (originalSelf === undefined) delete (globalThis as any).self
  else (globalThis as any).self = originalSelf
  mock.restore()
})

beforeEach(() => {
  matchAll.mockReset()
  showNotification.mockReset()
  showNotification.mockImplementation(async () => {})
  getNotifications.mockReset()
  getNotifications.mockImplementation(async () => [{}])
  setAppBadge.mockReset()
  setAppBadge.mockImplementation(async () => {})
})

const payload = {
  title: 'Character', body: 'Response finished', tag: 'generation-chat-1',
  data: { url: '/chat/chat-1', chatId: 'chat-1' },
}

async function receivePush() {
  let completion: Promise<unknown> | undefined
  handlers.get('push')!({
    data: { json: () => payload },
    waitUntil: (promise: Promise<unknown>) => { completion = promise },
  })
  expect(completion).toBeDefined()
  await completion
}

describe('service worker push delivery', () => {
  test.each([
    ['foreground PWA', [{ visibilityState: 'visible', focused: true }]],
    ['visible unfocused PWA', [{ visibilityState: 'visible', focused: false }]],
    ['background PWA', [{ visibilityState: 'hidden', focused: false }]],
    ['closed PWA', []],
  ] as const)('displays an already delivered push for a %s', async (_name, clients) => {
    matchAll.mockImplementation(async () => [...clients])
    await receivePush()
    expect(showNotification).toHaveBeenCalledTimes(1)
    expect(showNotification).toHaveBeenCalledWith(payload.title, {
      body: payload.body, tag: payload.tag, data: payload.data,
      icon: '/icon-192.png', badge: '/icon-192.png', image: undefined,
    })
    expect(setAppBadge).toHaveBeenCalledWith(1)
  })

  test('keeps delivery working when notification enumeration fails', async () => {
    getNotifications.mockImplementation(async () => { throw new Error('Unavailable') })
    await receivePush()
    expect(showNotification).toHaveBeenCalledTimes(1)
    expect(setAppBadge).not.toHaveBeenCalled()
  })

  test('keeps the push event successful when badging rejects', async () => {
    setAppBadge.mockImplementation(async () => { throw new Error('Badging denied') })
    await receivePush()
    expect(showNotification).toHaveBeenCalledTimes(1)
  })
})
