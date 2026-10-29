# better-auth-waitlist

[![npm](https://img.shields.io/npm/v/better-auth-waitlist)](https://www.npmjs.com/package/better-auth-waitlist)
[![license](https://img.shields.io/npm/l/better-auth-waitlist)](./LICENSE)

A [Better Auth](https://better-auth.com) plugin that puts sign-up behind a waitlist. People join, you approve them (or invite them directly), and only invited emails can create an account. Sign-in for existing users is never affected.

- **One gate for every sign-up method**: email and password, OAuth (redirect, ID token, One Tap), magic link, email OTP, anonymous, `admin.createUser`.
- **Single-use invite codes**, bound to one email, hashed at rest, with an expiry. The code survives OAuth and magic-link redirects.
- **Status links** showing the queue position, sent by email and confirmed with a POST so mail scanners can't confirm.
- **Referrals** with share links, self-referral detection and a success callback for your rewards.
- **Manager endpoints** to list, approve (by id or "next N"), reject, requeue, boost, invite and delete, gated by the admin plugin's roles or your own check.
- **No email enumeration**: join, refusals and timing look the same whether an email is new, pending, rejected or already a user.
- **Typed, tiny client** (about 2 kB gzipped). No server code, zod or `better-call` reaches the browser.
- Adapter-agnostic, ESM only, Better Auth `^1.7.0`.

> Coming from 3.x? v4 is a rewrite: read [Upgrading from v3](./docs/upgrading-from-v3.md).

## Install

```sh
pnpm add better-auth-waitlist
# or: npm install better-auth-waitlist / yarn add better-auth-waitlist / bun add better-auth-waitlist
```

`better-auth` and `@better-auth/core` (`^1.7.0`) are peer dependencies.

## Quick start

### 1. Add the plugin to your server

```ts
// auth.ts
import { betterAuth } from "better-auth"
import { admin } from "better-auth/plugins"
import { waitlist } from "better-auth-waitlist"

export const auth = betterAuth({
  // ...database, emailAndPassword, socialProviders
  plugins: [
    admin(), // admins are waitlist managers by default
    waitlist({
      statusLink: { buildUrl: (token) => `https://example.com/waitlist?token=${token}` },
      sendStatusLink: async ({ email, url }) => {
        await sendEmail(email, "You're on the waitlist", `Check your place in line: ${url}`)
      },
      invite: { buildUrl: (code) => `https://example.com/register?code=${code}` },
      sendInvite: async ({ email, url }) => {
        await sendEmail(email, "You're invited", `Create your account: ${url}`)
      },
    }),
  ],
  // Send emails after the response, so timing doesn't reveal who is on the list.
  advanced: { backgroundTasks: { handler: (promise) => waitUntil(promise) } },
})
```

### 2. Update your database

The plugin adds a `waitlistEntry` model. Generate or apply it with the [Better Auth CLI](https://www.better-auth.com/docs/concepts/cli), as for any plugin.

### 3. Add the client plugin

```ts
// auth-client.ts
import { createAuthClient } from "better-auth/client"
import { waitlistClient } from "better-auth-waitlist/client"

export const authClient = createAuthClient({ plugins: [waitlistClient()] })
```

### 4. Build three pages

**Join page.** Show the same "check your inbox" screen whatever happens, so the page never reveals whether an email is already on the list or already has an account (the email itself tells the person).

```ts
import { isWaitlistError, WAITLIST_ERROR_CODES } from "better-auth-waitlist/client"

const ref = new URLSearchParams(location.search).get("ref") ?? undefined
const { error } = await authClient.waitlist.join({ email, referralCode: ref })
if (isWaitlistError(error)) showMessage(WAITLIST_ERROR_CODES[error.code].message)
else showCheckYourInbox()
```

Only `WAITLIST_CLOSED`, `WAITLIST_FULL` and `EMAIL_NOT_ALLOWED` need their own message: they never depend on who the email belongs to.

**Status page** (the `statusLink.buildUrl` URL). Confirm the entry, then show the position and the share link.

```ts
const token = new URLSearchParams(location.search).get("token") ?? ""
await authClient.waitlist.confirm({ token }) // a POST, and idempotent
const { data, error } = await authClient.waitlist.status({ query: { token } })
if (error?.code === "INVALID_STATUS_TOKEN") showBadLink()
else if (data) {
  showPosition(data.position, data.queueLength) // position is null once approved
  showShareLink(`${location.origin}/join?ref=${data.referralCode}`, data.referralCount)
}
```

**Register page** (the `invite.buildUrl` URL). Check the code before showing the form, and lock the email field to the invited address.

```ts
import { getRedirectError } from "better-auth-waitlist/client"

const code = new URLSearchParams(location.search).get("code") ?? ""
const { data } = await authClient.waitlist.invite.accept({ code })
if (!data?.valid) showInvalidInvite()
else showSignUpForm({ email: data.email, emailLocked: true }) // any sign-up method works from here

// Back from an OAuth or magic-link sign-up that was refused:
const refused = getRedirectError(location.search) // "WAITLIST_INVITE_REQUIRED" | "INVALID_INVITE_CODE" | null
```

That's it: sign-up is now invite-only. Approve people from your admin UI (see [Managing the waitlist](./docs/managing.md)) with `authClient.waitlist.admin.approve(...)`, or from a job with `auth.api.approveWaitlistEntries(...)`.

## Documentation

- [How it works](./docs/how-it-works.md): entry statuses and transitions.
- [Managing the waitlist](./docs/managing.md): managers, approving, invites.
- [The sign-up gate](./docs/sign-up-gate.md): admission, refusals per sign-up method, bypasses, Guests.
- [Referrals](./docs/referrals.md): share links, success callback, rewards.
- [Client API](./docs/client-api.md): every endpoint, helpers, error codes, extra join fields.
- [Options](./docs/options.md): every option and callback with its default.
- [Production checklist](./docs/production-checklist.md)
- [Upgrading from v3](./docs/upgrading-from-v3.md)

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
