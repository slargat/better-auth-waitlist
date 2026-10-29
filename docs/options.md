# Options

All options are optional.

| Option                       | Default                        | Description                                                                                                           |
| ---------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `gate.enabled`               | `true`                         | Block sign-up for emails the waitlist doesn't admit.                                                                  |
| `gate.requireInviteCode`     | `true`                         | Require the invite code at sign-up, not only an approved entry.                                                       |
| `gate.bypass`                | lets `admin.createUser` in     | `({ user, ctx }) => boolean`: let a creation through without admission.                                               |
| `gate.allowWithoutContext`   | `false`                        | Send creations with no request context (your own `internalAdapter` calls) to `bypass` instead of refusing them.       |
| `gate.joinOnBlockedSignUp`   | `false`                        | Put refused emails on the waitlist and send their status link.                                                        |
| `join.enabled`               | `true`                         | Accept new entries.                                                                                                   |
| `join.maxEntries`            | none                           | Cap on pending entries (`WAITLIST_FULL` beyond it).                                                                   |
| `join.allowedDomains`        | all                            | Email domains allowed to join (case-insensitive).                                                                     |
| `join.validate`              | none                           | `({ email, name, emailVerified, request }) => boolean`: refuse with `EMAIL_NOT_ALLOWED`.                              |
| `join.autoApprove`           | `false`                        | `true`, or a predicate: approve on join and admit at sign-up without a code.                                          |
| `statusLink.buildUrl`        | required with `sendStatusLink` | `(token) => string`: your status page URL.                                                                            |
| `statusLink.resendAfter`     | `600`                          | Seconds before the same entry can be sent its status link again.                                                      |
| `invite.buildUrl`            | required with `sendInvite`     | `(code) => string`: your register page URL.                                                                           |
| `invite.expiresIn`           | `604800` (7 days)              | Invite lifetime in seconds, or `null` for never.                                                                      |
| `invite.codeLength`          | `24`                           | Length of the base62 code.                                                                                            |
| `invite.returnCodeToManager` | `false`                        | Return raw codes in manager responses.                                                                                |
| `invite.cookieMaxAge`        | `1800`                         | Invite cookie lifetime in seconds.                                                                                    |
| `invite.header`              | `"x-waitlist-invite"`          | Header that can carry the code.                                                                                       |
| `referral.enabled`           | `true`                         | Accept referral codes and record successes.                                                                           |
| `referral.successOn`         | `"confirm"`                    | `"confirm"` or `"register"`: when a referral counts.                                                                  |
| `referral.canonicalizeEmail` | strips `+tag`                  | Normalizes emails to detect self-referrals.                                                                           |
| `admin.permission`           | none                           | Access-control statement a manager's role must grant.                                                                 |
| `admin.canManage`            | admin plugin roles             | Replaces the manager check.                                                                                           |
| `rateLimit`                  | per endpoint                   | `{ [endpoint]: { window, max } }`, or `false`. Defaults: join 5/min, status 30/min, confirm and invite accept 10/min. |
| `schema.waitlistEntry`       |                                | `modelName` and `fields` to rename the table and columns, `additionalFields` to add columns.                          |

Callbacks:

| Callback             | Called with                                      | When                                                      |
| -------------------- | ------------------------------------------------ | --------------------------------------------------------- |
| `sendStatusLink`     | `{ entry, email, token, url, reason }`           | Someone joins, rejoins, or is put on the list by the gate |
| `sendInvite`         | `{ entry, email, code, url, expiresAt, reason }` | An invite is issued or resent                             |
| `onExistingUserJoin` | `{ user }`                                       | Someone who already has an account joins                  |
| `onJoin`             | `{ entry, referrer, source }`                    | An entry is created                                       |
| `onStatusChange`     | `{ entry, from, to, event, actorUserId }`        | An entry changes status                                   |
| `onReferralSuccess`  | `{ referrer, referred, referralCount }`          | A referred entry reaches `referral.successOn`             |

Callback errors are logged with codes, tokens and passwords redacted, and never fail the request. Predicates (`gate.bypass`, `join.validate`, `join.autoApprove`, `admin.canManage`, `referral.canonicalizeEmail`) treat a throw as "no".
