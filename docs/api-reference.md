# API reference

Every endpoint is available three ways:

- **Client**: `authClient.waitlist.*`, from `waitlistClient()`.
- **Server**: `auth.api.*`, for example `auth.api.joinWaitlist({ body })`.
- **HTTP**: under your Better Auth base path, for example `POST /api/auth/waitlist/join`.

Errors use Better Auth's error shape (`{ code, message }`) with the HTTP status listed in [Error codes](#error-codes). Every endpoint can also return `429` when its rate limit is hit (see the `rateLimit` option).

## Public endpoints

### Join

`POST /waitlist/join` · `authClient.waitlist.join` · `auth.api.joinWaitlist`

Adds an email to the waitlist and sends its status link (`sendStatusLink`). Anyone can call it.

| Body           | Type      | Description                                                         |
| -------------- | --------- | ------------------------------------------------------------------- |
| `email`        | `string`  | The email to add.                                                   |
| `name`         | `string?` | Display name, up to 100 characters.                                 |
| `referralCode` | `string?` | The referrer's code. An unknown code or a self-referral is ignored. |
| ...            |           | Any `schema.waitlistEntry.additionalFields`.                        |

Returns `{ success: true }`, the same for a new email, one already on the list and one that already has an account.

Errors: `WAITLIST_CLOSED` (`join.enabled` is `false`), `WAITLIST_FULL` (`join.maxEntries` reached), `EMAIL_NOT_ALLOWED` (`join.allowedDomains` or `join.validate`).

### Status

`GET /waitlist/status` · `authClient.waitlist.status` · `auth.api.getWaitlistStatus`

Reads an entry with the token from its status link.

| Query   | Type     | Description                     |
| ------- | -------- | ------------------------------- |
| `token` | `string` | The status token from the link. |

Returns:

| Field            | Type                                                    | Description                                       |
| ---------------- | ------------------------------------------------------- | ------------------------------------------------- |
| `email`          | `string`                                                |                                                   |
| `status`         | `"pending" \| "approved" \| "rejected" \| "registered"` |                                                   |
| `position`       | `number \| null`                                        | Place in line (1-based); `null` unless `pending`. |
| `queueLength`    | `number`                                                | Number of pending entries.                        |
| `referralCode`   | `string`                                                | For the share link.                               |
| `referralCount`  | `number`                                                | Successful referrals so far.                      |
| `emailConfirmed` | `boolean`                                               |                                                   |
| `invite`         | `{ expiresAt: Date \| null, expired: boolean } \| null` | Set while the entry is approved with an invite.   |

Errors: `INVALID_STATUS_TOKEN`.

### Confirm

`POST /waitlist/confirm` · `authClient.waitlist.confirm` · `auth.api.confirmWaitlistEntry`

Confirms the entry's inbox. Idempotent. It's a POST so that mail scanners opening the link don't confirm.

| Body    | Type     | Description                     |
| ------- | -------- | ------------------------------- |
| `token` | `string` | The status token from the link. |

Returns `{ success: true }`. Errors: `INVALID_STATUS_TOKEN`.

### Accept invite

`POST /waitlist/invite/accept` · `authClient.waitlist.invite.accept` · `auth.api.acceptWaitlistInvite`

Checks an invite code. When it's valid, sets the signed invite cookie that carries the code through the sign-up, including OAuth and magic-link redirects.

| Body   | Type     | Description                    |
| ------ | -------- | ------------------------------ |
| `code` | `string` | The invite code from the link. |

Returns `{ valid: true, email: string, expiresAt: Date | null }`, or `{ valid: false }` for an unknown, used or expired code. It never returns an error for a bad code, and never reveals an email without a valid one.

## Manager endpoints

All manager endpoints need a manager session (see [Managing the waitlist](./managing.md)). Without a session they return `401`; with a session that isn't a manager, `NOT_ALLOWED_TO_MANAGE_WAITLIST`. A server call (`auth.api.*`) without `headers` or `request` is trusted and skips the check.

Endpoints that return an entry return a [`WaitlistEntry`](#waitlistentry).

### List entries

`GET /waitlist/admin/list` · `authClient.waitlist.admin.list` · `auth.api.listWaitlistEntries`

| Query           | Type                                | Default   | Description                                       |
| --------------- | ----------------------------------- | --------- | ------------------------------------------------- |
| `status`        | `WaitlistStatus?`                   |           | Only entries in this status.                      |
| `search`        | `string?`                           |           | Part of the email, case-insensitive.              |
| `confirmed`     | `boolean?`                          |           | Only entries that did (`true`) or didn't confirm. |
| `referredById`  | `string?`                           |           | Only entries referred by this entry id.           |
| `sortBy`        | `"queue" \| "createdAt" \| "email"` | `"queue"` |                                                   |
| `sortDirection` | `"asc" \| "desc"`                   | `"asc"`   |                                                   |
| `limit`         | `number`                            | `50`      | 1 to 100.                                         |
| `offset`        | `number`                            | `0`       |                                                   |

Returns `{ entries: WaitlistEntry[], total: number }`. When listing the pending queue in queue order with no other filter, each entry also has its `position`.

### Stats

`GET /waitlist/admin/stats` · `authClient.waitlist.admin.stats` · `auth.api.getWaitlistStats`

Returns counts: `{ pending, pendingConfirmed, approved, approvedExpired, rejected, registered, successfulReferrals, total }`.

### Approve

`POST /waitlist/admin/approve` · `authClient.waitlist.admin.approve` · `auth.api.approveWaitlistEntries`

Approves entries and issues each a new invite (`sendInvite`). Takes either form:

| Body            | Type       | Description                                                           |
| --------------- | ---------- | --------------------------------------------------------------------- |
| `entryIds`      | `string[]` | Up to 100 entry ids.                                                  |
| `next`          | `number`   | Or: approve the first N pending entries in queue order (1 to 100).    |
| `confirmedOnly` | `boolean?` | With `next`: only entries that confirmed their email. Default `true`. |

Returns `{ results: { entryId, outcome, code? }[] }`. `outcome` is `"approved"`, `"skipped"`, `"invalid_transition"`, `"not_found"` or `"error"`. `code` is the raw invite code, only with `invite.returnCodeToManager`.

### Reject

`POST /waitlist/admin/reject` · `authClient.waitlist.admin.reject` · `auth.api.rejectWaitlistEntries`

Rejects entries and clears any invite.

| Body       | Type       | Description                                                      |
| ---------- | ---------- | ---------------------------------------------------------------- |
| `entryIds` | `string[]` | Up to 100 entry ids.                                             |
| `reason`   | `string?`  | Up to 500 characters. Stored for managers, never shown publicly. |

Returns `{ results: { entryId, outcome }[] }`, with `outcome` `"rejected"` or one of the values above.

### Requeue

`POST /waitlist/admin/requeue` · `authClient.waitlist.admin.requeue` · `auth.api.requeueWaitlistEntry`

Puts an approved or rejected entry back in the queue at its original place, clearing any invite.

Body: `{ entryId: string }`. Returns `{ entry }`. Errors: `ENTRY_NOT_FOUND`, `INVALID_STATUS_TRANSITION`.

### Resend invite

`POST /waitlist/admin/resend-invite` · `authClient.waitlist.admin.resendInvite` · `auth.api.resendWaitlistInvite`

Issues an approved entry a new invite. The old code stops working.

Body: `{ entryId: string }`. Returns `{ entry, code? }`. Errors: `ENTRY_NOT_FOUND`, `INVALID_STATUS_TRANSITION`.

### Invite

`POST /waitlist/admin/invite` · `authClient.waitlist.admin.invite` · `auth.api.inviteToWaitlist`

Approves an email directly, creating its entry if it isn't on the list.

| Body    | Type      | Description                         |
| ------- | --------- | ----------------------------------- |
| `email` | `string`  | The email to invite.                |
| `name`  | `string?` | Display name, up to 100 characters. |

Returns `{ entry, code? }`. Errors: `INVALID_STATUS_TRANSITION` (the email is already approved or registered; use resend invite for an approved one).

### Boost

`POST /waitlist/admin/boost` · `authClient.waitlist.admin.boost` · `auth.api.boostWaitlistEntry`

Moves a pending entry up the queue.

| Body      | Type     | Description                                                          |
| --------- | -------- | -------------------------------------------------------------------- |
| `entryId` | `string` |                                                                      |
| `seconds` | `number` | Seconds to move it ahead (up to ±10 years). Negative undoes a boost. |

Returns `{ entry }`. Errors: `ENTRY_NOT_FOUND`, `INVALID_STATUS_TRANSITION` (the entry isn't pending).

### Delete

`POST /waitlist/admin/delete` · `authClient.waitlist.admin.delete` · `auth.api.deleteWaitlistEntry`

Deletes an entry. Entries it referred are unlinked.

Body: `{ entryId: string }`. Returns `{ success: true }`. Errors: `ENTRY_NOT_FOUND`.

## Types

### WaitlistEntry

| Field                 | Type             | Description                                                |
| --------------------- | ---------------- | ---------------------------------------------------------- |
| `id`                  | `string`         |                                                            |
| `email`               | `string`         | Normalized (trimmed, lowercased).                          |
| `name`                | `string \| null` |                                                            |
| `status`              | `WaitlistStatus` | `"pending"`, `"approved"`, `"rejected"` or `"registered"`. |
| `queueScore`          | `number`         | Join time in ms, minus any boost. Lower is earlier.        |
| `boostSeconds`        | `number`         | Total boost.                                               |
| `referralCode`        | `string`         | This entry's own code, for share links.                    |
| `referredById`        | `string \| null` | The referrer's entry id.                                   |
| `referralSucceeded`   | `boolean`        | Whether this entry counted as a successful referral.       |
| `referralSucceededAt` | `Date \| null`   |                                                            |
| `emailConfirmed`      | `boolean`        | Confirmed through the status link or by signing up.        |
| `confirmedAt`         | `Date \| null`   |                                                            |
| `invitedAt`           | `Date \| null`   | When the current invite was issued.                        |
| `inviteExpiresAt`     | `Date \| null`   |                                                            |
| `userId`              | `string \| null` | The user created with the invite.                          |
| `decidedById`         | `string \| null` | The manager who last approved, rejected or requeued it.    |
| `decidedAt`           | `Date \| null`   |                                                            |
| `rejectionReason`     | `string \| null` |                                                            |
| `registeredAt`        | `Date \| null`   |                                                            |
| `lastNotifiedAt`      | `Date \| null`   | When the status link was last sent.                        |
| `version`             | `number`         | Increments on every change of status or invite.            |
| `createdAt`           | `Date`           |                                                            |
| `updatedAt`           | `Date`           |                                                            |

Plus any `additionalFields`. The invite code's hash is never returned.

## Error codes

| Code                             | HTTP | Message                            |
| -------------------------------- | ---- | ---------------------------------- |
| `WAITLIST_INVITE_REQUIRED`       | 403  | Waitlist invite required           |
| `INVALID_INVITE_CODE`            | 403  | Invalid or expired invite code     |
| `WAITLIST_CLOSED`                | 403  | Waitlist is closed                 |
| `WAITLIST_FULL`                  | 403  | Waitlist is full                   |
| `EMAIL_NOT_ALLOWED`              | 400  | Email not allowed                  |
| `INVALID_STATUS_TOKEN`           | 400  | Invalid status link                |
| `INVALID_STATUS_TRANSITION`      | 409  | Invalid waitlist status transition |
| `ENTRY_NOT_FOUND`                | 404  | Waitlist entry not found           |
| `NOT_ALLOWED_TO_MANAGE_WAITLIST` | 403  | Not allowed to manage the waitlist |

`WAITLIST_INVITE_REQUIRED` and `INVALID_INVITE_CODE` come from the sign-up gate, not from a waitlist endpoint: see [The sign-up gate](./sign-up-gate.md) for how each sign-up method reports them. All codes and messages are exported as `WAITLIST_ERROR_CODES` from `better-auth-waitlist/client`.
