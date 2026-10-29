# Managing the waitlist

The manager endpoints need a signed-in **manager**. By default that's whoever the [admin plugin](https://www.better-auth.com/docs/plugins/admin) treats as an admin: its `adminUserIds`, or a role in its `adminRoles` (default `["admin"]`).

- `admin.permission`, for example `{ waitlist: ["manage"] }`, requires an access-control statement from the admin plugin's `roles` instead.
- `admin.canManage(input)` replaces the check entirely.
- Without the admin plugin or `canManage`, nobody is a manager, and the plugin warns at startup.

The check reads the session and role from the database, not from a cookie cache, so a demoted manager loses access immediately.

```ts
// From your admin UI (manager session):
await authClient.waitlist.admin.approve({ entryIds: [id] })
await authClient.waitlist.admin.approve({ next: 20, confirmedOnly: true })
await authClient.waitlist.admin.invite({ email: "ada@example.com" })

// From server code, e.g. a nightly job: a call without headers is trusted.
await auth.api.approveWaitlistEntries({ body: { next: 20 } })
```

> **Forward the request headers when you call a manager endpoint on a user's behalf.** A server call without `headers` or `request` is trusted as your own code and skips the manager check.

## Invites

An invite is a random code (base62, 24 characters by default). The plugin stores only its SHA-256 hash, and the code expires after `invite.expiresIn` (7 days by default, `null` for never). `sendInvite` receives `{ entry, email, code, url, expiresAt, reason }`, where `reason` is `"approved"`, `"direct"`, `"resent"` or `"auto"`. Resending replaces the code, so the old one stops working. Set `invite.returnCodeToManager` to get the raw code in manager responses, for copy-and-paste invites.
