# @eusend_dev/better-auth

[Better Auth](https://better-auth.com) plugin for [eusend](https://eusend.dev), the
EU-native transactional email API.

- **Auth email:** verification, password reset and the "your password was changed" notice
  are set up by one plugin block, with clean default templates you can brand or replace. Senders for
  email OTP, magic links and organization invitations are one line each.
- **Contact sync (optional):** users are added to an eusend audience once they have verified
  their email address, and never before.

Every message is sent and stored on infrastructure in the EU.

## Install

```bash
npm install @eusend_dev/better-auth
```

Add your domain under [Domains](https://eusend.dev/domains), create an API key under
[API keys](https://eusend.dev/api-keys), and set it as `EUSEND_API_KEY`.

## Quick start

```ts
// auth.ts
import { betterAuth } from 'better-auth'
import { eusend } from '@eusend_dev/better-auth'

export const auth = betterAuth({
  emailAndPassword: { enabled: true, requireEmailVerification: true },
  emailVerification: { sendOnSignUp: true },
  plugins: [
    eusend({
      email: {
        from: 'Acme <auth@acme.com>',
        appName: 'Acme',
        brand: {
          logoUrl: 'https://acme.com/logo.png',
          primaryColor: '#4f46e5',
          supportEmail: 'help@acme.com',
        },
      },
    }),
  ],
})
```

That sets `sendVerificationEmail`, `sendResetPassword` and `onPasswordReset`.

### Your config always wins

Better Auth merges plugin options *underneath* your own. If you already have a
`sendVerificationEmail`, it keeps working and the plugin only fills in what is missing.
The plugin never turns on password sign-in either: `emailAndPassword.enabled` stays whatever
you set it to.

## Other plugins' emails

The OTP, magic-link and invitation senders belong to other Better Auth plugins, so you build
them once and pass them in:

```ts
import { eusend, eusendAuthEmails } from '@eusend_dev/better-auth'
import { emailOTP, magicLink, organization } from 'better-auth/plugins'

const emails = eusendAuthEmails({
  from: 'Acme <auth@acme.com>',
  appName: 'Acme',
  appUrl: 'https://app.acme.com', // for the invitation link
})

betterAuth({
  plugins: [
    eusend({ email: { from: 'Acme <auth@acme.com>', appName: 'Acme' } }),
    emailOTP({ sendVerificationOTP: emails.otp }),
    magicLink({ sendMagicLink: emails.magicLink }),
    organization({ sendInvitationEmail: emails.invitation }),
  ],
})
```

The six senders are `verification`, `resetPassword`, `passwordChanged`, `magicLink`, `otp` and
`invitation`. The invitation link defaults to `${appUrl}/accept-invitation/${id}`; pass
`invitationUrl: ({ id }) => ...` for a different route.

## Sends don't block the response

No sender waits for eusend to answer. That is what Better Auth recommends: an endpoint that
waits for the send responds faster when an address has no account, and that difference tells
an attacker which addresses are registered.

On a long-running server nothing else is needed. On serverless, the function can be frozen as
soon as the response goes out, so hand the send to the platform:

```ts
import { after } from 'next/server'

eusend({ waitUntil: after, email: { ... } })
```

`waitUntil` from `@vercel/functions` and a Worker's `ctx.waitUntil` work the same way.

## Contact sync

```ts
eusend({
  email: { from: 'Acme <auth@acme.com>', appName: 'Acme' },
  sync: {
    audienceId: process.env.EUSEND_AUDIENCE_ID!,
    properties: (user) => ({ user_id: user.id }),
  },
})
```

- **Verified addresses only.** A user who signs up with email and password is added once
  they verify. A user whose provider already verified them (Google, GitHub) is added at
  creation. A signup form accepts typos and other people's addresses, and mailing those is
  how a sending domain gets its reputation damaged.
- **Nothing is overwritten.** The sync merges into an existing contact. It never clears
  properties or names you set elsewhere, and it never removes an opt-out: someone who
  unsubscribed from your newsletter and later signs up stays unsubscribed.
- **Every sign-up path.** It runs on Better Auth's database hooks, so email and password,
  OAuth, magic link, OTP and admin-created users all go through it, alongside any database
  hooks of your own.

## Templates

The built-in templates are plain HTML with a text alternative, no React, and no eusend
branding — they read as coming from your app. Everything you pass in is HTML-escaped, and a
link that isn't `http(s)` is refused rather than rendered.

Replace any of them:

```ts
eusend({
  email: {
    from: 'auth@acme.com',
    appName: 'Acme',
    templates: {
      verification: ({ user, url }, { appName }) => ({
        subject: `Confirm your ${appName} account`,
        html: renderMyEmail({ user, url }),
        text: `Confirm: ${url}`,
      }),
    },
  },
})
```

## Errors

A failed send never throws into Better Auth; a sign-up still succeeds if its email could not
be sent. Failures are logged with `console.error`, or passed to your own handler:

```ts
eusend({
  onError: ({ category, to, code, message }) => logger.warn({ category, to, code }, message),
  email: { ... },
})
```

`code` is the eusend [error code](https://eusend.dev/docs/reference/error-codes), such as
`DOMAIN_NOT_VERIFIED` or `ALL_SUPPRESSED`.

Every message is tagged `source: better-auth` and `category: verification` (or
`reset-password`, `otp`, …), so you can filter auth mail in the eusend email log. Click
tracking is off for auth mail: link scanners that follow tracked links can use up a
single-use sign-in link before the user clicks it.

## Options

| Option | Where | |
|---|---|---|
| `apiKey` | top level | Defaults to `EUSEND_API_KEY`. |
| `waitUntil` | top level | Keeps sends alive after the response on serverless. |
| `onError` | top level | Receives `{ category, to, code, message }`. |
| `baseUrl` | top level | API host override, for staging. |
| `from` | `email` | Sender; its domain must be verified on eusend. |
| `appName` | `email` | Used in subjects and copy. |
| `brand` | `email` | `logoUrl`, `primaryColor` (hex), `supportEmail`. |
| `replyTo` | `email` | Reply-to address. |
| `templates` | `email` | Replace any of the six templates. |
| `tags` | `email` | Extra tags on every send, up to 8. |
| `appUrl` / `invitationUrl` | `email` | How invitation links are built. |
| `audienceId` | `sync` | Audience verified users are added to. |
| `properties` | `sync` | Custom contact properties from the user. |

## License

MIT
