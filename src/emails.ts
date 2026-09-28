import { Eusend } from '@eusend_dev/sdk'
import type { SendEmailOptions } from '@eusend_dev/sdk'

import { defaultTemplates, safeUrl } from './templates'
import type { Brand, OtpType, RenderedEmail, TemplateContext, Templates } from './templates'

export type EmailCategory = keyof Templates

export type EusendSendError = {
  category: EmailCategory | 'contactSync'
  to: string
  /** The eusend error code, e.g. `DOMAIN_NOT_VERIFIED`, or `NETWORK_ERROR` when the request never got an answer. */
  code: string
  message: string
}

export type EusendClientOptions = {
  /** Defaults to the `EUSEND_API_KEY` environment variable. */
  apiKey?: string
  /** Override the API host. Only useful against a staging deployment. */
  baseUrl?: string
  /**
   * Keeps the send alive after the response has gone out, on platforms that freeze the
   * function when it returns — `after` from `next/server`, `waitUntil` from
   * `@vercel/functions`, or a Worker's `ctx.waitUntil`. Without it the send is started and
   * not awaited, which is right for a long-running server.
   */
  waitUntil?: (promise: Promise<unknown>) => void
  /** Called when a send or a contact sync fails. Defaults to `console.error`. */
  onError?: (error: EusendSendError) => void
}

export type EusendAuthEmailOptions = EusendClientOptions & {
  /** Sender for every auth email, e.g. `Acme <auth@acme.com>`. Its domain must be verified on eusend. */
  from: string
  /** Your product name, used in subjects and copy. */
  appName: string
  replyTo?: string
  brand?: Brand
  /** Replace any of the built-in templates. Each receives the same data as the default. */
  templates?: Partial<Templates>
  /** Added to every send alongside `source: better-auth` and `category`. Up to 8. */
  tags?: Record<string, string>
  /**
   * Builds the link in organization invitation emails. Defaults to
   * `${appUrl}/accept-invitation/${id}`, the route Better Auth's docs use.
   */
  invitationUrl?: (invitation: { id: string; email: string }) => string
  /** Your app's public URL. Only needed for invitation emails, when `invitationUrl` is not set. */
  appUrl?: string
}

type AuthUser = { email: string; name?: string | null }

export type InvitationData = {
  id: string
  email: string
  role: string
  organization: { name: string }
  inviter: { user: { name: string; email: string } }
}

export type EusendAuthEmails = {
  /** For `emailVerification.sendVerificationEmail`. */
  verification: (data: { user: AuthUser; url: string }) => Promise<void>
  /** For `emailAndPassword.sendResetPassword`. */
  resetPassword: (data: { user: AuthUser; url: string }) => Promise<void>
  /** For `emailAndPassword.onPasswordReset` — the "was this you?" notice after a reset. */
  passwordChanged: (data: { user: AuthUser }) => Promise<void>
  /** For `magicLink({ sendMagicLink })`. */
  magicLink: (data: { email: string; url: string }) => Promise<void>
  /** For `emailOTP({ sendVerificationOTP })`. */
  otp: (data: { email: string; otp: string; type: OtpType }) => Promise<void>
  /** For `organization({ sendInvitationEmail })`. */
  invitation: (data: InvitationData) => Promise<void>
}

export function reportError(options: EusendClientOptions, error: EusendSendError): void {
  if (options.onError) {
    try {
      options.onError(error)
    } catch {}
    return
  }
  console.error(`[eusend] ${error.category} for ${error.to} failed: ${error.code} — ${error.message}`)
}

/**
 * Start `work` without making the caller wait for it. Better Auth asks for exactly this:
 * a reset endpoint that waits for the send answers faster for addresses with no account,
 * and that difference is how an attacker learns which addresses are registered.
 */
export function detach(options: EusendClientOptions, work: () => Promise<void>): Promise<void> {
  const running = work()
  if (options.waitUntil) options.waitUntil(running)
  return Promise.resolve()
}

export function lazyClient(options: EusendClientOptions): () => Eusend {
  let client: Eusend | undefined
  // Built on first use rather than at import, so a build step that loads auth.ts without
  // production env vars does not crash on the missing key.
  return () => (client ??= new Eusend(options.apiKey, options.baseUrl ? { baseUrl: options.baseUrl } : undefined))
}

/**
 * The six senders Better Auth's email hooks need, each rendering a template and sending it
 * through eusend. Pass them to the plugins the `eusend()` plugin cannot reach:
 *
 * ```ts
 * const emails = eusendAuthEmails({ from: 'Acme <auth@acme.com>', appName: 'Acme' })
 * emailOTP({ sendVerificationOTP: emails.otp })
 * ```
 *
 * Every sender resolves straight away and never rejects — failures go to `onError`.
 */
export function eusendAuthEmails(options: EusendAuthEmailOptions): EusendAuthEmails {
  const templates: Templates = { ...defaultTemplates, ...options.templates }
  const context: TemplateContext = { appName: options.appName, brand: options.brand ?? {} }
  const client = lazyClient(options)

  const send = (category: EmailCategory, to: string, render: () => RenderedEmail) =>
    detach(options, async () => {
      try {
        const email = render()
        const message: SendEmailOptions = {
          from: options.from,
          to,
          replyTo: options.replyTo,
          subject: email.subject,
          html: email.html,
          text: email.text,
          tags: { ...options.tags, source: 'better-auth', category: toTagValue(category) },
          // A tracked link is rewritten through a redirect, and some security scanners
          // follow every link in a message — which would burn a single-use sign-in or
          // reset link before the user ever clicks it.
          trackClicks: false,
        }
        const { error } = await client().emails.send(message)
        if (error) reportError(options, { category, to, code: error.name, message: error.message })
      } catch (error) {
        reportError(options, {
          category,
          to,
          code: 'NETWORK_ERROR',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    })

  return {
    verification: ({ user, url }) => send('verification', user.email, () => templates.verification({ user, url }, context)),
    resetPassword: ({ user, url }) =>
      send('resetPassword', user.email, () => templates.resetPassword({ user, url }, context)),
    passwordChanged: ({ user }) =>
      send('passwordChanged', user.email, () => templates.passwordChanged({ user }, context)),
    magicLink: ({ email, url }) => send('magicLink', email, () => templates.magicLink({ email, url }, context)),
    otp: ({ email, otp, type }) => send('otp', email, () => templates.otp({ email, otp, type }, context)),
    invitation: (data) =>
      send('invitation', data.email, () =>
        templates.invitation(
          {
            email: data.email,
            url: invitationLink(options, data),
            role: data.role,
            organizationName: data.organization.name,
            inviterName: data.inviter.user.name,
            inviterEmail: data.inviter.user.email,
          },
          context,
        ),
      ),
  }
}

function invitationLink(options: EusendAuthEmailOptions, data: InvitationData): string {
  if (options.invitationUrl) return options.invitationUrl({ id: data.id, email: data.email })
  if (!options.appUrl) {
    throw new Error('Set `appUrl` or `invitationUrl` to send organization invitation emails.')
  }
  return safeUrl(`${options.appUrl.replace(/\/+$/, '')}/accept-invitation/${encodeURIComponent(data.id)}`)
}

/** Tag values allow letters, digits, `_` and `-`, so `resetPassword` goes on the wire as `reset-password`. */
function toTagValue(category: EmailCategory): string {
  return category.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}
