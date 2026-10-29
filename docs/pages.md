# Building the pages

The plugin has no UI: your app provides three pages. The snippets use the client plugin from the [quick start](../README.md#quick-start); `show*` functions stand for your own UI.

## Join page

Show the same "check your inbox" screen whatever happens, so the page never reveals whether an email is already on the list or already has an account (the email itself tells the person).

```ts
import { isWaitlistError, WAITLIST_ERROR_CODES } from "better-auth-waitlist/client"

const ref = new URLSearchParams(location.search).get("ref") ?? undefined
const { error } = await authClient.waitlist.join({ email, referralCode: ref })
if (isWaitlistError(error)) showMessage(WAITLIST_ERROR_CODES[error.code].message)
else showCheckYourInbox()
```

Only `WAITLIST_CLOSED`, `WAITLIST_FULL` and `EMAIL_NOT_ALLOWED` need their own message: they never depend on who the email belongs to.

## Status page

The page behind `statusLink.buildUrl`. Confirm the entry, then show the position and the share link.

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

## Register page

The page behind `invite.buildUrl`. Check the code before showing the form, and lock the email field to the invited address.

```ts
import { getRedirectError } from "better-auth-waitlist/client"

const code = new URLSearchParams(location.search).get("code") ?? ""
const { data } = await authClient.waitlist.invite.accept({ code })
if (!data?.valid) showInvalidInvite()
else showSignUpForm({ email: data.email, emailLocked: true }) // any sign-up method works from here

// Back from an OAuth or magic-link sign-up that was refused:
const refused = getRedirectError(location.search) // "WAITLIST_INVITE_REQUIRED" | "INVALID_INVITE_CODE" | null
```
