import type { BetterAuthPlugin } from 'better-auth'

import { eusendAuthEmails } from './emails'
import type { EusendAuthEmailOptions, EusendClientOptions } from './emails'
import { createContactSync } from './sync'
import type { ContactSyncOptions, SyncedUser } from './sync'

export { eusendAuthEmails } from './emails'
export type {
  EmailCategory,
  EusendAuthEmailOptions,
  EusendAuthEmails,
  EusendClientOptions,
  EusendSendError,
  InvitationData,
} from './emails'
export { createContactSync, splitName } from './sync'
export type { ContactSyncOptions, SyncedUser } from './sync'
export { defaultTemplates, escapeHtml, renderLayout, safeUrl } from './templates'
export type { Brand, OtpType, RenderedEmail, TemplateContext, Templates } from './templates'

export type EusendPluginOptions = EusendClientOptions & {
  /** Send Better Auth's verification, password-reset and password-changed emails. Omit to leave them to you. */
  email?: Omit<EusendAuthEmailOptions, keyof EusendClientOptions>
  /** Add users to an eusend audience once their email is verified. Omit to turn syncing off. */
  sync?: Omit<ContactSyncOptions, keyof EusendClientOptions>
}

/**
 * Better Auth plugin for [eusend](https://eusend.dev), EU-native transactional email.
 *
 * Everything it sets is a default. Better Auth merges plugin options underneath the app's
 * own, so a `sendVerificationEmail` you already wrote keeps working and this plugin only
 * fills the gaps. Adding it cannot switch on password sign-in.
 */
export const eusend = (options: EusendPluginOptions = {}) => {
  const { email, sync: syncOptions, ...client } = options
  const emails = email ? eusendAuthEmails({ ...client, ...email }) : null
  const sync = syncOptions ? createContactSync({ ...client, ...syncOptions }) : null

  // Better Auth hands the same context object to an update's `before` and `after` hooks,
  // which is how the update that sets `emailVerified` is told apart from a later name change.
  const verifying = new WeakSet<object>()

  return {
    id: 'eusend',
    init() {
      return {
        options: {
          ...(emails
            ? {
                emailVerification: { sendVerificationEmail: emails.verification },
                emailAndPassword: {
                  // Required by the type. `false` is Better Auth's own default, and the app's
                  // `enabled: true` wins the merge, so this can never switch password sign-in on.
                  enabled: false,
                  sendResetPassword: emails.resetPassword,
                  onPasswordReset: emails.passwordChanged,
                },
              }
            : {}),
          // Database hooks, not endpoint hooks: they fire for every way a user is created or
          // verified — email and password, OAuth, magic link, OTP, admin — and they run
          // alongside the app's own database hooks rather than replacing them.
          ...(sync
            ? {
                databaseHooks: {
                  user: {
                    create: {
                      // OAuth users arrive already verified; everyone else waits for the update below.
                      after: async (user: SyncedUser) => {
                        await sync(user)
                      },
                    },
                    update: {
                      before: async (data: Partial<SyncedUser>, context: object | null) => {
                        if (data.emailVerified === true && context) verifying.add(context)
                      },
                      after: async (user: SyncedUser, context: object | null) => {
                        // Without a request context the two hooks cannot be paired, so a bare update
                        // is never treated as a verification. Mailing someone who never confirmed
                        // their address is a worse mistake than missing a sync.
                        if (context && verifying.delete(context)) await sync(user)
                      },
                    },
                  },
                },
              }
            : {}),
        },
      }
    },
  } satisfies BetterAuthPlugin
}
