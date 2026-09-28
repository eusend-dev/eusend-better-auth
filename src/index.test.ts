import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { betterAuth } from 'better-auth'
import type { BetterAuthOptions } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'

import { eusend, eusendAuthEmails, type EusendPluginOptions, type EusendSendError } from './index'
import { defaultTemplates, escapeHtml, safeUrl } from './templates'

type SentBody = {
  to?: string
  from?: string
  subject?: string
  html: string
  text?: string
  tags: Record<string, string>
  track_clicks?: boolean
  contacts: { email: string; first_name?: string; last_name?: string; properties?: Record<string, string> }[]
}

type Request = { path: string; body: SentBody }

const realFetch = globalThis.fetch
let requests: Request[]
let pending: Promise<unknown>[]
let respond: (path: string) => { status: number; body: unknown }

beforeEach(() => {
  requests = []
  pending = []
  respond = (path) => ({ status: 200, body: path.includes('/contacts/batch') ? { count: 1, duplicates: 0 } : { id: 'email_1' } })

  globalThis.fetch = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (!url.hostname.endsWith('eusend.dev')) return realFetch(input, init)
    requests.push({ path: url.pathname, body: JSON.parse(String(init?.body ?? '{}')) })
    const { status, body } = respond(url.pathname)
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

const settle = async () => {
  await Promise.all(pending)
  pending = []
}

const emailsSent = () => requests.filter((r) => r.path === '/emails').map((r) => r.body)
const syncs = () => requests.filter((r) => r.path.endsWith('/contacts/batch')).map((r) => r.body)

function makeAuth(plugin: Partial<EusendPluginOptions> = {}, app: Partial<BetterAuthOptions> = {}) {
  const db = { user: [], session: [], account: [], verification: [] }
  return betterAuth({
    baseURL: 'http://localhost:3000',
    secret: 'test-secret-that-is-long-enough-for-better-auth',
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true, requireEmailVerification: true },
    emailVerification: { sendOnSignUp: true },
    ...app,
    plugins: [
      eusend({
        apiKey: 'eu_test_key',
        waitUntil: (promise) => pending.push(promise),
        email: { from: 'Acme <auth@acme.com>', appName: 'Acme' },
        ...plugin,
      }),
    ],
  })
}

async function signUp(auth: ReturnType<typeof makeAuth>, email = 'ada@example.com') {
  await auth.api.signUpEmail({ body: { email, password: 'correct-horse-battery', name: 'Ada Lovelace' } })
  await settle()
}

function linkIn(body: SentBody): string {
  const match = /href="(http[^"]+)"/.exec(body.html)
  if (!match) throw new Error('no link in email')
  return match[1]!.replace(/&amp;/g, '&')
}

describe('auth emails through the plugin', () => {
  test('sign-up sends the verification email with tags and without click tracking', async () => {
    await signUp(makeAuth())

    const [sent] = emailsSent()
    expect(sent?.to).toBe('ada@example.com')
    expect(sent?.from).toBe('Acme <auth@acme.com>')
    expect(sent?.subject).toBe('Verify your email for Acme')
    expect(sent?.text).toContain('http://localhost:3000/api/auth/verify-email?token=')
    expect(sent?.html).toContain('Hi Ada,')
    expect(sent?.tags).toEqual({ source: 'better-auth', category: 'verification' })
    expect(sent?.track_clicks).toBe(false)
  })

  test('password reset and the password-changed notice both go out', async () => {
    const auth = makeAuth({}, { emailAndPassword: { enabled: true } })
    await signUp(auth)
    await auth.api.requestPasswordReset({ body: { email: 'ada@example.com', redirectTo: '/reset' } })
    await settle()

    const reset = emailsSent().find((e) => e.tags.category === 'reset-password')
    expect(reset?.subject).toBe('Reset your Acme password')

    const token = new URL(linkIn(reset!)).pathname.split('/').pop()!
    await auth.api.resetPassword({ body: { token, newPassword: 'a-brand-new-password' } })
    await settle()

    expect(emailsSent().some((e) => e.tags.category === 'password-changed')).toBe(true)
  })

  test("the app's own sender wins over the plugin's", async () => {
    const own: string[] = []
    const auth = makeAuth(
      {},
      {
        emailVerification: {
          sendOnSignUp: true,
          sendVerificationEmail: async ({ user }) => {
            own.push(user.email)
          },
        },
      },
    )
    await signUp(auth)

    expect(own).toEqual(['ada@example.com'])
    expect(emailsSent()).toHaveLength(0)
  })

  test('adding the plugin does not turn password sign-in on', async () => {
    const auth = makeAuth({}, { emailAndPassword: undefined })
    expect(auth.api.signUpEmail({ body: { email: 'a@example.com', password: 'correct-horse-battery', name: 'A' } })).rejects.toThrow()
  })

  test('the endpoint does not wait for the send', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const slow = globalThis.fetch
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      await gate
      return slow(...args)
    }) as typeof fetch

    const auth = makeAuth({ waitUntil: undefined })
    await auth.api.signUpEmail({ body: { email: 'ada@example.com', password: 'correct-horse-battery', name: 'Ada' } })

    expect(emailsSent()).toHaveLength(0)
    release()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(emailsSent()).toHaveLength(1)
  })

  test('failures go to onError instead of throwing', async () => {
    respond = () => ({ status: 403, body: { error: 'Domain not verified', code: 'DOMAIN_NOT_VERIFIED' } })
    const errors: EusendSendError[] = []
    await signUp(makeAuth({ onError: (error) => errors.push(error) }))

    expect(errors).toEqual([
      { category: 'verification', to: 'ada@example.com', code: 'DOMAIN_NOT_VERIFIED', message: 'Domain not verified' },
    ])
  })
})

test('a throwing onError still gets the failure logged, not lost', async () => {
  respond = () => ({ status: 403, body: { error: 'Domain not verified', code: 'DOMAIN_NOT_VERIFIED' } })
  const logged: unknown[][] = []
  const realError = console.error
  console.error = (...args: unknown[]) => logged.push(args)
  try {
    await signUp(
      makeAuth({
        onError: () => {
          throw new Error('handler broke')
        },
      }),
    )
  } finally {
    console.error = realError
  }

  expect(logged.some((args) => String(args[0]).includes('DOMAIN_NOT_VERIFIED'))).toBe(true)
})

describe('contact sync', () => {
  const sync = { audienceId: 'aud_1' }

  test('an unverified signup is not synced; verifying it is', async () => {
    const auth = makeAuth({ sync })
    await signUp(auth)
    expect(syncs()).toHaveLength(0)

    const token = new URL(linkIn(emailsSent()[0]!)).searchParams.get('token')!
    await auth.api.verifyEmail({ query: { token } })
    await settle()

    expect(requests.filter((r) => r.path.endsWith('/contacts/batch')).map((r) => r.path)).toEqual(['/audiences/aud_1/contacts/batch'])
    expect(syncs()[0]?.contacts).toEqual([{ email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace' }])
  })

  test('later updates to a verified user do not sync again', async () => {
    const auth = makeAuth({ sync })
    await signUp(auth)
    const token = new URL(linkIn(emailsSent()[0]!)).searchParams.get('token')!
    await auth.api.verifyEmail({ query: { token } })
    await settle()

    const { headers } = await auth.api.signInEmail({
      body: { email: 'ada@example.com', password: 'correct-horse-battery' },
      returnHeaders: true,
    })
    const cookie = headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
    await auth.api.updateUser({ body: { name: 'Ada King' }, headers: new Headers({ cookie }) })
    await settle()

    const ctx = await auth.$context
    expect((await ctx.internalAdapter.findUserByEmail('ada@example.com'))?.user.name).toBe('Ada King')
    expect(syncs()).toHaveLength(1)
  })

  test('a user created already verified is synced straight away', async () => {
    const auth = makeAuth({ sync })
    const ctx = await auth.$context
    await ctx.internalAdapter.createUser({ email: 'grace@example.com', name: 'Grace', emailVerified: true }, { method: 'admin' })
    await settle()

    expect(syncs()[0]?.contacts).toEqual([{ email: 'grace@example.com', first_name: 'Grace' }])
  })

  test('custom properties ride along', async () => {
    const auth = makeAuth({ sync: { audienceId: 'aud_1', properties: (user) => ({ user_id: user.id }) } })
    const ctx = await auth.$context
    const created = await ctx.internalAdapter.createUser({ email: 'grace@example.com', name: 'Grace', emailVerified: true }, { method: 'admin' })
    await settle()

    expect(syncs()[0]?.contacts[0].properties).toEqual({ user_id: created.id })
  })
})

describe('senders for other plugins', () => {
  const emails = () =>
    eusendAuthEmails({
      apiKey: 'eu_test_key',
      from: 'auth@acme.com',
      appName: 'Acme',
      appUrl: 'https://app.acme.com/',
      waitUntil: (promise) => pending.push(promise),
    })

  test('OTP subject names the flow and carries the code', async () => {
    await emails().otp({ email: 'ada@example.com', otp: '482913', type: 'forget-password' })
    await settle()

    expect(emailsSent()[0]?.subject).toBe('Your Acme password reset code: 482913')
    expect(emailsSent()[0]?.tags.category).toBe('otp')
  })

  test('invitation link is built from appUrl', async () => {
    await emails().invitation({
      id: 'inv 1',
      email: 'bob@example.com',
      role: 'member',
      organization: { name: 'Lovelace & Co' },
      inviter: { user: { name: 'Ada', email: 'ada@example.com' } },
    })
    await settle()

    const sent = emailsSent()[0]!
    expect(sent.subject).toBe('Ada invited you to Lovelace & Co on Acme')
    expect(sent.html).toContain('https://app.acme.com/accept-invitation/inv%201')
    expect(sent.html).toContain('Lovelace &amp; Co')
  })

  test('invitation without appUrl reports instead of sending a broken link', async () => {
    const errors: EusendSendError[] = []
    const noUrl = eusendAuthEmails({
      apiKey: 'eu_test_key',
      from: 'auth@acme.com',
      appName: 'Acme',
      onError: (error) => errors.push(error),
      waitUntil: (promise) => pending.push(promise),
    })
    await noUrl.invitation({
      id: 'inv_1',
      email: 'bob@example.com',
      role: 'member',
      organization: { name: 'Org' },
      inviter: { user: { name: 'Ada', email: 'ada@example.com' } },
    })
    await settle()

    expect(emailsSent()).toHaveLength(0)
    expect(errors[0]?.message).toMatch(/appUrl/)
  })

  test('a custom template replaces the default', async () => {
    const custom = eusendAuthEmails({
      apiKey: 'eu_test_key',
      from: 'auth@acme.com',
      appName: 'Acme',
      waitUntil: (promise) => pending.push(promise),
      templates: { magicLink: ({ url }) => ({ subject: 'Your link', html: `<a href="${url}">go</a>`, text: url }) },
    })
    await custom.magicLink({ email: 'ada@example.com', url: 'https://app.acme.com/magic?token=x' })
    await settle()

    expect(emailsSent()[0]?.subject).toBe('Your link')
  })
})

describe('templates', () => {
  const context = { appName: 'Acme <script>', brand: { primaryColor: 'red;background:url(x)' } }

  test('escapes user-controlled text', () => {
    const { html } = defaultTemplates.verification({ user: { email: 'a@example.com', name: '<b>Eve</b>' }, url: 'https://x.test/v' }, context)
    expect(html).not.toContain('<b>Eve</b>')
    expect(html).not.toContain('Acme <script>')
    expect(html).toContain(escapeHtml('<b>Eve</b>'))
  })

  test('ignores a primary colour that is not a hex value', () => {
    const { html } = defaultTemplates.magicLink({ email: 'a@example.com', url: 'https://x.test/m' }, context)
    expect(html).not.toContain('url(x)')
  })

  test('refuses a non-http link', () => {
    expect(() => safeUrl('javascript:alert(1)')).toThrow()
    expect(() => defaultTemplates.magicLink({ email: 'a@example.com', url: 'javascript:alert(1)' }, context)).toThrow()
  })
})
