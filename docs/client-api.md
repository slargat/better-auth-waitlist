# Client API

`waitlistClient()` adds `authClient.waitlist`, typed from the server plugin. Every client call has a server equivalent on `auth.api`. Parameters and responses are in the [API reference](./api-reference.md).

| Client (`authClient.waitlist.*`) | Server (`auth.api.*`)    | Who                          |
| -------------------------------- | ------------------------ | ---------------------------- |
| `join`                           | `joinWaitlist`           | Anyone                       |
| `status`                         | `getWaitlistStatus`      | Anyone with the status token |
| `confirm`                        | `confirmWaitlistEntry`   | Anyone with the status token |
| `invite.accept`                  | `acceptWaitlistInvite`   | Anyone with the invite code  |
| `admin.list`                     | `listWaitlistEntries`    | Managers                     |
| `admin.stats`                    | `getWaitlistStats`       | Managers                     |
| `admin.approve`                  | `approveWaitlistEntries` | Managers                     |
| `admin.reject`                   | `rejectWaitlistEntries`  | Managers                     |
| `admin.requeue`                  | `requeueWaitlistEntry`   | Managers                     |
| `admin.resendInvite`             | `resendWaitlistInvite`   | Managers                     |
| `admin.invite`                   | `inviteToWaitlist`       | Managers                     |
| `admin.boost`                    | `boostWaitlistEntry`     | Managers                     |
| `admin.delete`                   | `deleteWaitlistEntry`    | Managers                     |

`better-auth-waitlist/client` also exports:

- `getRedirectError(search)`: reads a refused OAuth or magic-link sign-up from `location.search`, a URL or `URLSearchParams`, including with hash routers.
- `isWaitlistError(error)`: narrows an error to a waitlist error code.
- `WAITLIST_ERROR_CODES`: every code with its message. Use it to show messages: Better Auth's `authClient.$ERROR_CODES` has the codes in its type but no runtime value.
- The `WaitlistEntry` and `WaitlistStatus` types. `better-auth-waitlist/types` has every public type and no runtime code.

Error codes: `WAITLIST_INVITE_REQUIRED`, `INVALID_INVITE_CODE`, `WAITLIST_CLOSED`, `WAITLIST_FULL`, `EMAIL_NOT_ALLOWED`, `INVALID_STATUS_TOKEN`, `INVALID_STATUS_TRANSITION`, `ENTRY_NOT_FOUND`, `NOT_ALLOWED_TO_MANAGE_WAITLIST`.

## Extra fields on join

To collect more on join (a company name, say), add fields to the schema and give the client the **same** definition. Nothing checks that the two agree, so share one object:

```ts
// waitlist-fields.ts, imported by both the server and the client config
export const waitlistSchema = {
  waitlistEntry: { additionalFields: { company: { type: "string", required: false } } },
} as const

waitlist({ schema: waitlistSchema }) // auth.ts
waitlistClient({ schema: waitlistSchema }) // auth-client.ts
```
