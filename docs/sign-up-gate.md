# The sign-up gate

While the plugin is active, a user can only be created for an **admitted** email: one whose entry is `approved`, with a live invite and the matching code. Admission uses the invite up, so one invite creates exactly one account. The gate is a single database hook on user creation, so it covers every sign-up method, including your own `internalAdapter.createUser` calls. **Sign-in is never gated**: existing users, including ones created before you installed the plugin, keep signing in as before.

`invite.accept({ code })` sets a signed, HttpOnly invite cookie (30 minutes by default) that carries the code through OAuth and magic-link redirects. Server-side callers can send the code in the `x-waitlist-invite` header instead, and the header wins over the cookie.

How each method reports a refusal:

| Method                             | Refusal                                                                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Email and password                 | 403 `WAITLIST_INVITE_REQUIRED` or `INVALID_INVITE_CODE`\*                                                                         |
| OAuth redirect, magic link         | Redirect to `errorCallbackURL` with `?error=WAITLIST_INVITE_REQUIRED` (or `INVALID_INVITE_CODE`). Read it with `getRedirectError` |
| OAuth ID token, One Tap, email OTP | 403 JSON with the code                                                                                                            |

\* With `requireEmailVerification` or `autoSignIn: false`, Better Auth hides the refusal behind its normal sign-up response (no user, no email). That's why the register page checks the code first.

No refusal says whether an email is pending, rejected or not on the list.

## Letting some users through

- `join.autoApprove`: approve on join, and admit at sign-up without a code. As a predicate, it gets `emailVerified`, which is only true when an identity provider vouched for the email. **A predicate that trusts a domain must check it**, because an email sign-up can type any address:

  ```ts
  waitlist({
    join: { autoApprove: ({ email, emailVerified }) => emailVerified && email.endsWith("@corp.example") },
  })
  ```

- `gate.bypass({ user, ctx })`: return `true` to let a creation through, for example staff you invite another way. The default lets `admin.createUser` through. **A bypass that matches on the email must also check `user.emailVerified`.**
- `gate.requireInviteCode: false`: admit any approved email with a live invite, without the code.

## Guests: users with no account

If your app creates user rows outside sign-up (a checkout or a booking that records the customer's email), those users have no account and can't sign in. The plugin calls them **Guests**:

- They can join the waitlist like anyone else.
- An email sign-up with the entry's invite code **claims** the existing row: it attaches a password to the same user id (so your linked data stays), marks the email verified and registers the entry. Without a valid code, Better Auth's usual `USER_ALREADY_EXISTS` refusal stays, so knowing a Guest's email isn't enough to take over the row.
- Password reset, which would otherwise give a Guest a login, is blocked until the gate would admit them.

Users with at least one account are unaffected.
