# better-auth-waitlist

A [Better Auth](https://better-auth.com) plugin that gates sign-up behind an **Auth waitlist** (see [`CONTEXT.md`](./CONTEXT.md)). MIT licensed.

> **v4 is a rewrite.** Coming from 3.x? Read [Upgrading from v3](#upgrading-from-v3) first. Contributors: read [`CONTEXT.md`](./CONTEXT.md) and [`CODING_STANDARDS.md`](./CODING_STANDARDS.md).

## Install

```sh
pnpm add better-auth-waitlist
```

Peers: `better-auth` and `@better-auth/core`, `^1.7.0`.

```ts
// auth.ts
import { betterAuth } from "better-auth"
import { waitlist } from "better-auth-waitlist"

export const auth = betterAuth({ plugins: [waitlist()] })

// auth-client.ts
import { createAuthClient } from "better-auth/client"
import { waitlistClient } from "better-auth-waitlist/client"

export const authClient = createAuthClient({ plugins: [waitlistClient()] })
```

## Client

`waitlistClient()` gives `authClient.waitlist` every endpoint, typed from the server plugin (imported as a type only, so no server code, zod or `better-call` reaches a browser bundle):

- Public: `join({ email, name?, referralCode?, ...additionalFields })`, `status({ query: { token } })`, `confirm({ token })`, `invite.accept({ code })`.
- Manager: `admin.list({ query })`, `admin.stats()`, `admin.approve({ entryIds } | { next, confirmedOnly? })`, `admin.reject`, `admin.requeue`, `admin.resendInvite`, `admin.invite`, `admin.boost`, `admin.delete`. They need a manager session; there are no atoms, so nothing calls them on its own.

If the server has `schema.waitlistEntry.additionalFields`, give the client the same fields so `join` takes them. The client can't see the server's options, and nothing checks that the two agree: a field added on the server only is missing from `join`'s type, and one left on the client only is sent and refused. Keep one definition and import it on both sides:

```ts
// waitlist-fields.ts: imported by the server and the client config, so they can't drift.
export const waitlistSchema = {
  waitlistEntry: { additionalFields: { company: { type: "string", required: false } } },
} as const

// auth.ts
waitlist({ schema: waitlistSchema })

// auth-client.ts
createAuthClient({ plugins: [waitlistClient({ schema: waitlistSchema })] })
```

### Host flows

**Join page.** Call `join`, then show the same "check your inbox" screen whatever happened: `join` answers `{ success: true }` alike for a new email, one already on the list and one that already has an account (the email itself says which). "Has an account" means a user with at least one account (a password or a social login); only they get `onExistingUserJoin`. A **Guest**, a user row with no account (say one your app created for an order or a booking), can't sign in, so they get a normal entry and the `"joined"` status link instead. Only the errors that never depend on the email (`WAITLIST_CLOSED`, `WAITLIST_FULL`, `EMAIL_NOT_ALLOWED`) need their own message.

```ts
const { error } = await authClient.waitlist.join({ email, referralCode: params.get("ref") ?? undefined })
if (isWaitlistError(error)) showMessage(WAITLIST_ERROR_CODES[error.code].message)
else showCheckYourInbox() // the same screen for every email
```

**Status page** (the emailed status link, `statusLink.buildUrl`). Read `token`, `confirm` first (it's a POST, so a mail scanner opening the link doesn't confirm), then `status`, and show the position and the share link.

```ts
const token = new URLSearchParams(location.search).get("token") ?? ""
await authClient.waitlist.confirm({ token }) // idempotent
const { data, error } = await authClient.waitlist.status({ query: { token } })
if (error?.code === "INVALID_STATUS_TOKEN") showBadLink()
else if (data) {
  showPosition(data.position, data.queueLength) // position is null once approved
  showShareLink(`${location.origin}/join?ref=${data.referralCode}`, data.referralCount)
}
```

**Register page** (the invite link): `invite.accept({ code })` first, see [Sign-up gate](#sign-up-gate); on an OAuth or magic-link return, `getRedirectError`.

### Helpers

Two helpers that don't fetch, on `authClient.waitlist` and as named exports of `better-auth-waitlist/client`:

- `getRedirectError(search)`: after an OAuth or magic-link sign-up returns to your `errorCallbackURL`, returns `"WAITLIST_INVITE_REQUIRED"`, `"INVALID_INVITE_CODE"` or `null`. It takes `location.search`, a whole URL or `URLSearchParams`, and matches the `error` param against the code and the underscored message (`Waitlist_invite_required`), ignoring case. With a hash router (`/#/register?error=...`), the query before `#` wins, and the hash route's query is read only when the main query has no `error`.
- `isWaitlistError(error)`: true when an error's `code` is a waitlist code, narrowing it (`authClient.waitlist.join(...)`'s `error`, for example).

```ts
const refused = getRedirectError(location.search)
if (refused === "INVALID_INVITE_CODE") showExpiredInvite()
else if (refused === "WAITLIST_INVITE_REQUIRED") showJoinForm()
```

`./client` also exports `WAITLIST_ERROR_CODES` (with each message) and the `WaitlistEntry` and `WaitlistStatus` types. `authClient.$ERROR_CODES` includes the waitlist codes in its type, but Better Auth's client has no runtime value for it: use `WAITLIST_ERROR_CODES` to read a message. `better-auth-waitlist/types` has every public type and no runtime code.

## Requirements

- **Set `advanced.backgroundTasks.handler`** (for example `waitUntil` on Workers or Vercel) when you pass `sendStatusLink`, `onExistingUserJoin`, or `sendInvite` with `join.autoApprove`. Without it, Better Auth awaits the callback inside the join request, so a join that sends mail takes longer than one that doesn't, and response timing reveals whether an email is already on the list. The plugin warns at startup when the handler is missing.
- **Set it too for `gate.joinOnBlockedSignUp`.** The blocked sign-up's join can't run inside the refused creation's transaction, so it goes to `runInBackground`; without a handler that work is detached, and a serverless runtime may drop it. The plugin warns at startup.
- **Know what single-use rests on without transactions.** When a user is created inside a real database transaction (email sign-up and OAuth on adapters with transactions), the gate claims the invite in that transaction, so exactly one account can use it. Magic link, email OTP and the other methods create users outside a transaction, and an adapter with `transaction: false` (drizzle's default) has none at all. There the gate only checks the code before the user is created and uses the invite up afterwards, so a failed creation can be retried; single-use then rests on the code being bound to one email and on the unique index on `user.email`.
- **Use an adapter that enforces unique indexes.** Join relies on the unique index on `email` to reject duplicates. Better Auth's memory adapter doesn't enforce them, so concurrent or repeat joins can create duplicate entries there; the plugin warns at startup.

## Managers

The `/waitlist/admin/*` endpoints (`auth.api.listWaitlistEntries`, `approveWaitlistEntries`, `rejectWaitlistEntries`, and the rest) need a manager session. By default a manager is whoever the admin plugin treats as an admin: its `adminUserIds`, or a role in its `adminRoles` (default `["admin"]`). Set `admin.permission` (for example `{ waitlist: ["manage"] }`) to require an access-control statement from the admin plugin's `roles` instead, or `admin.canManage` to replace the check. Without the admin plugin or `canManage`, nobody is a manager, and the plugin warns at startup.

The check reads the session and the user's role from the database, not the cookie cache or a secondary-storage snapshot, so a demoted manager loses access at once. A server call with no `headers` and no `request` is trusted and needs no session, for example a cron job running `auth.api.approveWaitlistEntries({ body: { next: 20 } })`.

**Always forward the request headers when you call a manager endpoint on a user's behalf.** A headerless `auth.api` call is trusted as server code, so dropping the headers skips the manager check.

## Invites

Approving an entry (by id, `next: N`, direct invite, resend or `join.autoApprove`) issues an invite: a random code whose SHA-256 hash is stored on the entry, with an expiry (`invite.expiresIn`, default 7 days, `null` for never). Pass `sendInvite` and `invite.buildUrl` to email it; startup throws if `sendInvite` is set without `buildUrl`. `sendInvite` receives `{ entry, email, code, url, expiresAt, reason }`, where `reason` is `"approved" | "direct" | "resent" | "auto"`. A resend replaces the code, so the old one stops working. Set `invite.returnCodeToManager` to also get the raw `code` in manager responses, for copy-and-paste invites. Callback errors are logged without their payload, and raw codes and URLs are redacted from the log line.

## Sign-up gate

While the plugin is active, a user can be created only for an admitted email: one whose entry is `approved` with a live invite and the matching invite code. Admission uses the invite up, so one invite gives exactly one account; a `registered` entry never admits again, so a user who changes their email leaves no open door on the old one. Deleting a user deletes their entry: to come back, they rejoin or are invited again. The gate is one database hook on user creation, so it covers every way a user is created: email and password, OAuth (redirect, ID token, One Tap), magic link, email OTP, anonymous, `admin.createUser` and direct `internalAdapter` calls. **Sign-in is never gated**: existing users, including ones created before you installed the plugin, sign in by every method as before.

The register page, reached only through the invite link (`invite.buildUrl`), calls `authClient.waitlist.invite.accept({ code })` **before** it shows the form:

- `{ valid: false }`: show "This invite is invalid or expired, ask for a new one".
- `{ valid: true, email, expiresAt }`: show the sign-up form with `email` **prefilled and locked**. The code is bound to that email; any other email is refused. The call also sets a signed, HttpOnly invite cookie (`<cookiePrefix>.waitlist_invite`, `invite.cookieMaxAge`, default 30 minutes) that carries the code through OAuth and magic-link redirects, so every method works from that browser.

A server-side caller can send the code in the `x-waitlist-invite` header (`invite.header`) instead; the header wins over the cookie. The code works once: after sign-up the entry is `registered`, the invite is cleared, and the cookie is expired.

How a refusal reaches the client:

| Method                             | Refusal                                                                                                                                                                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Email and password                 | 403 `WAITLIST_INVITE_REQUIRED` or `INVALID_INVITE_CODE`. With `requireEmailVerification` or `autoSignIn: false`, Better Auth masks it as its generic sign-up success (no user, no email): this is the no-enumeration behaviour, and why the register page checks the code first |
| OAuth redirect, magic link         | redirect to `errorCallbackURL` with `?error=WAITLIST_INVITE_REQUIRED` (or `INVALID_INVITE_CODE`); read it with `getRedirectError`                                                                                                                                               |
| OAuth ID token, One Tap, email OTP | 403 JSON with the code                                                                                                                                                                                                                                                          |

No refusal says whether the email is pending, rejected or not on the list. Sending a magic link or an OTP isn't gated, so it reveals nothing either.

### Guests: users with no account

If your app creates user rows outside sign-up (a checkout or a booking that records the customer by email), those users have no account, so no way to sign in, and the gate never saw them. The plugin calls them **Guests** and keeps the gate meaningful for them:

- **Join:** a Guest gets an entry and the status link, not `onExistingUserJoin`.
- **Sign-up:** Better Auth refuses an existing email with `422 USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`. While the gate is on, an email sign-up that carries the entry's invite code (header or invite cookie) instead **claims** the Guest's row: a credential account is attached to the same user id (so everything you linked to it stays), the email is marked verified, the entry is `registered`, and the response is a normal sign-up response. Without a valid code, or with the gate off, the 422 stays: the code is what proves the inbox, so nobody who merely knows a Guest's email can take over the row.
- **Password reset:** Better Auth's reset gives a user with no account a credential account. While the gate is on, a Guest the gate wouldn't admit gets no reset email (with Better Auth's usual response, so nothing is revealed), and `/reset-password` refuses with `WAITLIST_INVITE_REQUIRED` for a token issued earlier. An admitted Guest's reset works and registers their entry. With the gate off, reset works for Guests: it's their way to get a login.

Users with at least one account are unaffected by all three.

Options:

- `gate.requireInviteCode` (default `true`): `false` admits an approved email with a live invite without the code.
- `join.autoApprove`: an email it approves is admitted without a code (an approved entry is created if there is none). A predicate gets `emailVerified`: at sign-up it's true only when the email was proven (an IdP's verified claim), and an email sign-up is unverified. A predicate that trusts a domain must check it, or pair it with `requireEmailVerification`:

  ```ts
  waitlist({
    // Company emails skip the queue, but only once the IdP vouches for them.
    // (On join, emailVerified is false: the invite email is the proof there.)
    join: { autoApprove: ({ email, emailVerified }) => emailVerified && email.endsWith("@corp.example") },
  })
  ```

- `gate.bypass({ user, ctx })` (default: `admin.createUser`): return `true` to let a creation through without admission, for example staff your app invites another way. Replacing it replaces the default. Users without an email (anonymous, phone, SIWE) are refused unless a bypass lets them in. **A bypass that matches on the email must also check `user.emailVerified`** (or match on something only the invitee has, such as a token in the request): an email sign-up can type any email, so an email-only rule lets anyone take over that address.

  ```ts
  waitlist({
    gate: {
      // Staff your app invited elsewhere, once their IdP has proven the email.
      bypass: async ({ user }) => user.emailVerified === true && (await isInvitedStaff(user.email)),
    },
  })
  ```

- `gate.allowWithoutContext` (default `false`): a creation with no endpoint context (your own `internalAdapter.createUser` call) is refused, so a missing AsyncLocalStorage can't open the gate. `true` sends it on to `bypass` (with `ctx: null`) and admission.
- `gate.joinOnBlockedSignUp` (default `false`): put a refused email on the waitlist (following the `join` rules) and send its status link with `reason: "blocked-sign-up"`. The entry survives the rollback of the refused creation.
- `gate.enabled` (default `true`).

If the write that registers the entry fails after the user was created, the sign-up still succeeds and the error is logged; the next status read for that entry registers it. A user email with surrounding spaces is refused.

Host functions that answer a question (`gate.bypass`, `join.validate`, `join.autoApprove`, `admin.canManage`, `referral.canonicalizeEmail`) count a throw as "no": it's logged, redacted, and never turns into a 500.

## Referrals

Every entry has a public `referralCode` (in the status response, for share links). Joining with someone's code records them as the referrer:

```ts
await authClient.waitlist.join({ email, referralCode: new URLSearchParams(location.search).get("ref") ?? undefined })
```

An unknown or malformed code and a self-referral are ignored silently, and the join answers the same either way. A self-referral is a join whose email has the same `referral.canonicalizeEmail` form as the referrer's. **The default only strips a `+tag`** from the local part, so `ada+2@example.com` can't use `ada@example.com`'s code, but `a.da@gmail.com` and `ada@googlemail.com` can. Replace it with a stricter rule if rewards are worth gaming:

```ts
waitlist({
  referral: {
    canonicalizeEmail: (email) => {
      const at = email.lastIndexOf("@")
      let local = email.slice(0, at).split("+")[0] ?? ""
      let domain = email.slice(at + 1)
      // Gmail ignores dots, and googlemail.com is the same mailbox.
      if (domain === "googlemail.com") domain = "gmail.com"
      if (domain === "gmail.com") local = local.replaceAll(".", "")
      return `${local}@${domain}`
    },
  },
})
```

When the referred entry reaches `referral.successOn`, the plugin records the success on the referred entry, **exactly once**, and calls `onReferralSuccess({ referrer, referred, referralCount }, ctx)`:

- `"confirm"` (the default): the referred person proves their inbox, by confirming through the status link, or by signing up with their invite code or a verified email (signing up confirms the entry).
- `"register"`: the referred person signs up.

`referralCount` is the referrer's number of successful referrals, counted after this one; it's also in the status response. `ctx` is the request that reached the milestone, or `null` for a user your own code created with no request (`gate.allowWithoutContext`).

**Exactly once is per entry, not per person.** If the referred entry is deleted (by a manager, or with its user) and the person joins again with the same code, that's a new entry, and it can succeed again. If you reward, dedupe on `referred.email`.

**The plugin never rewards on its own**: referrals don't move anyone in the queue. To reward, boost the referrer from the callback (a server call with no headers is trusted):

```ts
waitlist({
  onReferralSuccess: async ({ referrer, referralCount }) => {
    // One hour ahead per successful referral, for the first ten.
    if (referralCount <= 10) await auth.api.boostWaitlistEntry({ body: { entryId: referrer.id, seconds: 3600 } })
  },
})
```

Only a `pending` entry can be boosted, so a referrer who has already been approved gets a 409 there (logged).

**`onReferralSuccess` is called once and never retried.** The success is recorded before the call, so if your handler throws, the error is logged and the call is not repeated. If you need guaranteed delivery, keep the handler to one write to your own outbox table, and process the outbox from a job that retries:

```ts
waitlist({
  onReferralSuccess: async ({ referrer, referred, referralCount }) => {
    // One insert, unique on the referred email (so a re-joined person isn't
    // rewarded twice): the job does the reward, with retries.
    await db
      .insert(referralOutbox)
      .values({ referredEmail: referred.email, referrerId: referrer.id, referralCount })
      .onConflictDoNothing()
  },
})
```

Options:

- `referral.enabled` (default `true`): `false` ignores codes on join and records no successes.
- `referral.successOn` (default `"confirm"`): `"register"` counts a referral only once the referred person has an account.
- `referral.canonicalizeEmail`: see above. It is called twice for every join that carries a code, whatever the code matches, so its timing doesn't tell a valid code from an unknown one.

Deleting the referrer's entry (a manager delete, or deleting its user) unlinks the entries it referred, and their later successes aren't counted, whether or not your database enforces the `referredById` reference.

Callback errors are logged with the request's credentials redacted (passwords, codes and tokens in the body), so a handler that quotes the sign-up `ctx` it was given doesn't leak a password.

## Development

```sh
pnpm install
pnpm build                # vp pack (tsdown, ESM only) + publint --strict + client-graph and declaration checks
pnpm typecheck            # tsc --noEmit
pnpm test                 # vp test (unit + *.test-d.ts type tests)
pnpm test:postgres:local  # the Postgres suites against a throwaway postgres:16 container (needs Docker)
pnpm lint                 # vp lint (Oxlint) + vp fmt --check (Oxfmt)
pnpm lint:package         # publint --strict on the packed tarball
pnpm lint:types           # attw --profile esm-only
```

Lint, format, build and test settings all live in [`vite.config.ts`](./vite.config.ts). The Postgres suites are the `postgres` test project; `pnpm test:postgres` runs them against `WAITLIST_TEST_DATABASE_URL`.

The client-graph check (`scripts/check-client-graph.mjs`, run by `build`) parses every module `dist/client.mjs` reaches with the TypeScript parser and fails if any imports zod, `better-call`, server code or any package but `@better-auth/core/utils/error-codes` (statically, by re-export or by `import()`), has an `import()` with a computed specifier, calls `require()`, or uses an ES2022-or-later built-in; also if `dist/types.mjs` has code, or if the client is over its **2.5 kB gzip budget** (about 2.0 kB today, `defineErrorCodes` included). `src/tests/client-graph.test.ts` runs it on fixtures. Raise the budget only on purpose, in the PR that needs it.

`build` also type-checks the emitted declarations as a consumer would (`scripts/check-dts.mjs`, `skipLibCheck: false`, only errors in `dist/` count), so a declaration-bundler slip fails here and not in a host's `tsc`.

The client's `version` comes from a build-time define (`__WAITLIST_VERSION__`, set from `package.json` for both the build and the tests); code compiled without it reports `"dev"`.

CI also runs typecheck and both test suites with `better-auth` and `@better-auth/core` swapped for the 1.7.0 floor and the latest 1.7.x.

To try a local change in an app before it is released, link the checkout from the app (`pnpm link ../better-auth-waitlist`, or a `link:` override) and run `pnpm build` here: the `exports` map resolves to `dist/`.

## Releasing

Releases go through [Changesets](https://github.com/changesets/changesets) and `.github/workflows/release.yml` (npm trusted publishing, with provenance; no npm token). Add a changeset in your PR:

```sh
pnpm changeset
```

Merging to `main` opens or updates the "Version Packages" PR; merging that PR publishes to npm, tags the release and creates the GitHub Release.

## Upgrading from v3

v4 is a rewrite, not an incremental release. It needs `better-auth` and `@better-auth/core` `^1.7.0`, is ESM only, and ships three entries: `better-auth-waitlist` (server plugin), `better-auth-waitlist/client` and `better-auth-waitlist/types`.

There is **no automatic data migration**. v4 stores entries in a new model, `waitlistEntry`, with different statuses (`pending`, `approved`, `rejected`, `registered`) and fields. Generate the new schema with the Better Auth CLI, then re-import the entries you want to keep (for example, re-add them through `auth.api` join or manager calls) and drop the v3 `waitlist` table once you are done.

The v3 options map roughly as follows:

| v3                                     | v4                                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `enabled`                              | `join.enabled` (accepting entries) and `gate.enabled` (blocking sign-up)                              |
| `allowedDomains`                       | `join.allowedDomains`                                                                                 |
| `maximumWaitlistParticipants`          | `join.maxEntries`                                                                                     |
| `autoApprove`                          | `join.autoApprove`                                                                                    |
| `validateEntry`                        | `join.validate`                                                                                       |
| `additionalFields`, `schema`           | `schema.waitlistEntry.additionalFields` (give the client the same fields)                             |
| `disableSignInAndSignUp`               | removed: the gate only blocks sign-up of emails the waitlist doesn't admit; sign-in is never affected |
| `canManageWaitlist(user)`              | `admin.canManage(input)` or `admin.permission` (defaults to the admin plugin's roles)                 |
| `onJoinRequest`                        | `onJoin`                                                                                              |
| `onStatusChange`                       | `onStatusChange` (new payload: `from`, `to`, `event`, `actorUserId`)                                  |
| `notifications`                        | `sendStatusLink` and `sendInvite` (you send the emails)                                               |
| `rateLimit: { maxAttempts, windowMs }` | `rateLimit`, per endpoint: `{ window, max }`, or `false`                                              |

New in v4: invite codes and the invite cookie, the sign-up gate across every sign-up method, Guests, referrals, status links and a typed client. The v3 source stays on the [`v3` branch](https://github.com/slargat/better-auth-waitlist/tree/v3) and is no longer maintained.
