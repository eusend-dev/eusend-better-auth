import { detach, lazyClient, reportError } from './emails'
import type { EusendClientOptions } from './emails'

export type SyncedUser = { id: string; email: string; name?: string | null; emailVerified?: boolean | null }

export type ContactSyncOptions = EusendClientOptions & {
  /** The eusend audience verified users are added to. */
  audienceId: string
  /**
   * Custom contact properties to set from the user, e.g. `(user) => ({ plan: user.plan })`.
   * Merged into what the contact already has, never replacing it.
   */
  properties?: (user: SyncedUser) => Record<string, string>
}

/** Users carry one `name`; contacts carry two. "Ada Lovelace King" gives a last name of "Lovelace King". */
export function splitName(name: string | null | undefined): { firstName?: string; lastName?: string } {
  const trimmed = name?.trim() ?? ''
  if (!trimmed) return {}
  const gap = trimmed.indexOf(' ')
  if (gap === -1) return { firstName: trimmed }
  return { firstName: trimmed.slice(0, gap), lastName: trimmed.slice(gap + 1) }
}

/**
 * Adds verified users to an audience.
 *
 * Unverified addresses are never synced. A signup form accepts typos and addresses that are
 * not the signer's own, and broadcasting to those is the bounce and complaint rate that gets
 * a sending domain blocked.
 *
 * The write goes through the batch endpoint, which merges instead of replacing: it cannot
 * clear an existing contact's properties or names, and it can add an opt-out but never
 * remove one. Someone who unsubscribed and then signs up stays unsubscribed.
 */
export function createContactSync(options: ContactSyncOptions) {
  const client = lazyClient(options)

  return (user: SyncedUser) =>
    detach(options, async () => {
      if (!user.emailVerified || !user.email) return
      try {
        const { error } = await client().audiences.batchCreateContacts(options.audienceId, {
          contacts: [{ email: user.email, ...splitName(user.name), properties: options.properties?.(user) }],
        })
        if (error) {
          reportError(options, { category: 'contactSync', to: user.email, code: error.name, message: error.message })
        }
      } catch (error) {
        reportError(options, {
          category: 'contactSync',
          to: user.email,
          code: 'NETWORK_ERROR',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    })
}
