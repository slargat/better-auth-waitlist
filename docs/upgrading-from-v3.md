# Upgrading from v3

v4 is a rewrite. It needs `better-auth` and `@better-auth/core` `^1.7.0`, is ESM only, and ships three entry points: `better-auth-waitlist` (server), `better-auth-waitlist/client` and `better-auth-waitlist/types`.

There is **no automatic data migration**. v4 stores entries in a new `waitlistEntry` model, with the statuses `pending`, `approved`, `rejected` and `registered`. Generate the new schema with the Better Auth CLI, re-add the entries you want to keep (through `auth.api` join or manager calls), then drop the v3 `waitlist` table.

| v3                                     | v4                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `enabled`                              | `join.enabled` (accepting entries) and `gate.enabled` (blocking sign-up)                       |
| `allowedDomains`                       | `join.allowedDomains`                                                                          |
| `maximumWaitlistParticipants`          | `join.maxEntries`                                                                              |
| `autoApprove`                          | `join.autoApprove`                                                                             |
| `validateEntry`                        | `join.validate`                                                                                |
| `additionalFields`, `schema`           | `schema.waitlistEntry.additionalFields` (give the client the same fields)                      |
| `disableSignInAndSignUp`               | Removed: the gate only blocks sign-up for emails the waitlist doesn't admit, and never sign-in |
| `canManageWaitlist(user)`              | `admin.canManage(input)` or `admin.permission` (defaults to the admin plugin's roles)          |
| `onJoinRequest`                        | `onJoin`                                                                                       |
| `onStatusChange`                       | `onStatusChange` (new payload: `from`, `to`, `event`, `actorUserId`)                           |
| `notifications`                        | `sendStatusLink` and `sendInvite` (you send the emails)                                        |
| `rateLimit: { maxAttempts, windowMs }` | `rateLimit`, per endpoint: `{ window, max }`, or `false`                                       |

The v3 source stays on the [`v3` branch](https://github.com/slargat/better-auth-waitlist/tree/v3) and is no longer maintained.
