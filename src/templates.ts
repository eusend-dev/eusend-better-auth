export type Brand = {
  /** Shown above every email. Use an absolute https URL; mail clients cannot load relative ones. */
  logoUrl?: string
  /** Button and link colour, as a hex value. Defaults to a neutral near-black. */
  primaryColor?: string
  /** Printed in the footer as the place to reply to. */
  supportEmail?: string
}

export type RenderedEmail = { subject: string; html: string; text: string }

export type TemplateContext = { appName: string; brand: Brand }

export type OtpType = 'sign-in' | 'email-verification' | 'forget-password' | 'change-email'

export type Templates = {
  verification: (
    data: { user: { email: string; name?: string | null }; url: string },
    context: TemplateContext,
  ) => RenderedEmail
  resetPassword: (
    data: { user: { email: string; name?: string | null }; url: string },
    context: TemplateContext,
  ) => RenderedEmail
  passwordChanged: (
    data: { user: { email: string; name?: string | null } },
    context: TemplateContext,
  ) => RenderedEmail
  magicLink: (data: { email: string; url: string }, context: TemplateContext) => RenderedEmail
  otp: (data: { email: string; otp: string; type: OtpType }, context: TemplateContext) => RenderedEmail
  invitation: (
    data: {
      email: string
      url: string
      role: string
      organizationName: string
      inviterName: string
      inviterEmail: string
    },
    context: TemplateContext,
  ) => RenderedEmail
}

const DEFAULT_COLOR = '#18181b'

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Only http(s) URLs make it into an href. Better Auth builds these links itself, but the
 * base URL comes from config and request headers, and a `javascript:` link in an auth email
 * is the one mistake that must be impossible rather than unlikely.
 */
export function safeUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString()
  } catch {}
  throw new Error(`Refusing to put a non-http(s) URL in an email: ${value}`)
}

function color(brand: Brand): string {
  const value = brand.primaryColor?.trim()
  return value && /^#[0-9a-f]{3,8}$/i.test(value) ? value : DEFAULT_COLOR
}

function greeting(name: string | null | undefined): string {
  const first = name?.trim().split(/\s+/)[0]
  return first ? `Hi ${first},` : 'Hi,'
}

type Block = { kind: 'p'; text: string } | { kind: 'button'; label: string; url: string } | { kind: 'code'; code: string }

export function renderLayout(
  { appName, brand }: TemplateContext,
  { preheader, blocks, footnote }: { preheader: string; blocks: Block[]; footnote: string },
): { html: string; text: string } {
  const accent = color(brand)
  const logo = brand.logoUrl
    ? `<img src="${escapeHtml(safeUrl(brand.logoUrl))}" alt="${escapeHtml(appName)}" height="32" style="display:block;height:32px;width:auto;border:0;margin:0 0 24px">`
    : `<div style="font-size:18px;font-weight:600;color:#18181b;margin:0 0 24px">${escapeHtml(appName)}</div>`

  const body = blocks
    .map((block) => {
      if (block.kind === 'p') {
        return `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:#3f3f46">${escapeHtml(block.text)}</p>`
      }
      if (block.kind === 'code') {
        return `<p style="margin:8px 0 24px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:28px;letter-spacing:6px;font-weight:600;color:#18181b">${escapeHtml(block.code)}</p>`
      }
      const href = escapeHtml(safeUrl(block.url))
      return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px"><tr><td style="border-radius:6px;background:${accent}"><a href="${href}" style="display:inline-block;padding:12px 20px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px">${escapeHtml(block.label)}</a></td></tr></table>
<p style="margin:0 0 16px;font-size:13px;line-height:20px;color:#71717a">Or paste this link into your browser:<br><a href="${href}" style="color:${accent};word-break:break-all">${href}</a></p>`
    })
    .join('\n')

  const support = brand.supportEmail
    ? ` Questions? Write to <a href="mailto:${escapeHtml(brand.supportEmail)}" style="color:#71717a">${escapeHtml(brand.supportEmail)}</a>.`
    : ''

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#f4f4f5">
<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:8px;border:1px solid #e4e4e7">
<tr><td style="padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
${logo}
${body}
</td></tr>
</table>
<p style="max-width:520px;margin:16px auto 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:#71717a">${escapeHtml(footnote)}${support}</p>
</td></tr>
</table>
</body>
</html>`

  const text = [
    ...blocks.map((block) => {
      if (block.kind === 'p') return block.text
      if (block.kind === 'code') return block.code
      return `${block.label}: ${safeUrl(block.url)}`
    }),
    '',
    '—',
    footnote + (brand.supportEmail ? ` Questions? Write to ${brand.supportEmail}.` : ''),
  ].join('\n\n')

  return { html, text }
}

const OTP_COPY: Record<OtpType, { subject: string; lead: string }> = {
  'sign-in': { subject: 'sign-in code', lead: 'Use this code to sign in to' },
  'email-verification': { subject: 'verification code', lead: 'Use this code to verify your email address for' },
  'forget-password': { subject: 'password reset code', lead: 'Use this code to reset your password for' },
  'change-email': { subject: 'code to confirm your new email', lead: 'Use this code to confirm your new email address for' },
}

export const defaultTemplates: Templates = {
  verification: ({ user, url }, context) => ({
    subject: `Verify your email for ${context.appName}`,
    ...renderLayout(context, {
      preheader: `Confirm your email address to finish setting up ${context.appName}.`,
      blocks: [
        { kind: 'p', text: greeting(user.name) },
        { kind: 'p', text: `Confirm that ${user.email} is your email address to finish setting up your ${context.appName} account.` },
        { kind: 'button', label: 'Verify email', url },
      ],
      footnote: `If you didn't create a ${context.appName} account, you can ignore this email.`,
    }),
  }),

  resetPassword: ({ user, url }, context) => ({
    subject: `Reset your ${context.appName} password`,
    ...renderLayout(context, {
      preheader: `Someone asked to reset the password for ${user.email}.`,
      blocks: [
        { kind: 'p', text: greeting(user.name) },
        { kind: 'p', text: `Someone asked to reset the password for your ${context.appName} account. Choose a new one with the button below.` },
        { kind: 'button', label: 'Reset password', url },
      ],
      footnote: "If you didn't ask for this, you can ignore this email — your password stays the same.",
    }),
  }),

  passwordChanged: ({ user }, context) => ({
    subject: `Your ${context.appName} password was changed`,
    ...renderLayout(context, {
      preheader: `The password for ${user.email} was just changed.`,
      blocks: [
        { kind: 'p', text: greeting(user.name) },
        { kind: 'p', text: `The password for your ${context.appName} account (${user.email}) was just changed.` },
        { kind: 'p', text: "If this was you, there's nothing else to do." },
      ],
      footnote: `If you didn't change it, reset your password straight away and contact ${context.appName} support.`,
    }),
  }),

  magicLink: ({ url }, context) => ({
    subject: `Sign in to ${context.appName}`,
    ...renderLayout(context, {
      preheader: `Your sign-in link for ${context.appName}.`,
      blocks: [
        { kind: 'p', text: `Use the button below to sign in to ${context.appName}. The link works once and expires shortly.` },
        { kind: 'button', label: `Sign in to ${context.appName}`, url },
      ],
      footnote: "If you didn't try to sign in, you can ignore this email.",
    }),
  }),

  otp: ({ otp, type }, context) => {
    const copy = OTP_COPY[type] ?? OTP_COPY['sign-in']
    return {
      subject: `Your ${context.appName} ${copy.subject}: ${otp}`,
      ...renderLayout(context, {
        preheader: `${copy.lead} ${context.appName}.`,
        blocks: [
          { kind: 'p', text: `${copy.lead} ${context.appName}:` },
          { kind: 'code', code: otp },
          { kind: 'p', text: 'The code expires shortly. Never share it with anyone.' },
        ],
        footnote: "If you didn't ask for this code, you can ignore this email.",
      }),
    }
  },

  invitation: ({ url, organizationName, inviterName, inviterEmail, role }, context) => ({
    subject: `${inviterName} invited you to ${organizationName} on ${context.appName}`,
    ...renderLayout(context, {
      preheader: `Join ${organizationName} on ${context.appName}.`,
      blocks: [
        { kind: 'p', text: `${inviterName} (${inviterEmail}) invited you to join ${organizationName} on ${context.appName} as ${role}.` },
        { kind: 'button', label: 'Accept invitation', url },
      ],
      footnote: "If you weren't expecting this invitation, you can ignore this email.",
    }),
  }),
}
