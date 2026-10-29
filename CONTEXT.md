# Better Auth waitlist — terminology

Glossary for `better-auth-waitlist`, a Better Auth plugin that gates **account creation** behind a waitlist. It is a generic, published library: it knows nothing about what a host application does with its users. Read this before adding terms to issues, PRs or code. If your change conflicts with a definition here, update the definition in the same PR.

Behaviour: the [README](./README.md) and [`docs/`](./docs). Implementation rules: [`CODING_STANDARDS.md`](./CODING_STANDARDS.md).

## Terms

- **Auth waitlist** — the queue of people who asked for an account before sign-up is open to them. While the plugin is active, a user record can be created only for an email the Auth waitlist admits (see **Status**). It gates _sign-up_ only; it never affects sign-in of an existing user.
  - **Not a queue for anything else.** Host apps often have their own "waitlists" (for a sold-out event, a product restock, ...). This one gates sign-up only; in host code and issues, call it the **Auth waitlist** to keep them apart.
- **Waitlist entry** — one email's place on the Auth waitlist, with its **Status** and the time it joined.
- **Status** — the state of a Waitlist entry, moved only through the transitions of an explicit state machine. The states are `pending`, `approved`, `rejected` and `registered` (terminal); the transitions are the table in `src/state-machine.ts`, and `CODING_STANDARDS.md` lists the invariants they must keep.
- **Position** — an entry's place in the queue. It is derived from ordering (join time, then a tiebreaker) when read, never stored.
- **Manager** — a signed-in user allowed to manage the Auth waitlist (approve, reject, requeue, invite, boost, delete). The check is pluggable; the default follows the admin plugin.
- **Trusted server call** — an `auth.api.*` call with no headers and no request. It runs host code, not a browser, so manager endpoints accept it without a session.
- **Invite code** — a secret that lets one specific email sign up ahead of the queue. It is stored hashed, single-use, bound to that email, and it expires.
- **Invite link / register page** — the invite email's link to the host's register page, the only sign-up UI while the Auth waitlist is active. The page checks the code with `/waitlist/invite/accept` first, which returns the invited email (prefilled and locked in the form) and sets the **invite cookie** that carries the code through OAuth and magic-link redirects.
- **Gate** — the check on user _creation_ (a database hook) that refuses an email the Auth waitlist doesn't admit. It never runs on sign-in. A **Guest** already has a user row, so two request hooks and the account-creation hook carry the gate to them (sign-up claim, password reset).
- **Admission** — the Gate's yes: the entry is `approved` with a live invite and its code, and the creation claims that invite. One invite gives one account; a `registered` entry never admits again.
- **Erasure** — deleting a user deletes the entry linked to it; the person rejoins or is invited again.
- **Blocked sign-up** — a user creation the Gate refused. Optionally (`joinOnBlockedSignUp`) the email is put on the Auth waitlist.
- **Referral code** — a public, short code on every entry, used in share links. Joining with it records the code's entry as the **Referrer** of the new (**Referred**) entry. It grants nothing; an unknown code or a self-referral is ignored.
- **Successful referral** — a Referred entry that reached the configured milestone (confirming its inbox by default, or registering), recorded once on the Referred entry. The Referrer's **referral count** is the number of its Successful referrals, counted when read, never stored. The plugin only tracks referrals; any reward is the host's, through a boost.
- **Redirect error** — the Gate code (`WAITLIST_INVITE_REQUIRED` or `INVALID_INVITE_CODE`) in the `error` param of the URL an OAuth or magic-link sign-up returns to after a refusal. The client's `getRedirectError` reads it.
- **Bypass** — a host rule that lets a creation through without Admission (by default, users an admin creates).
- **Existing user / account holder** — a user with **at least one account** (a password or a social login), so someone who can sign in. Only they get `onExistingUserJoin` ("you already have an account") when they join; they never get an entry.
- **Guest** — a user with **no account** rows: a real email, maybe data the host attached to the user id, but no way to sign in. Hosts write them outside sign-up (say, for an order or a booking), so the Gate never saw them. To the Auth waitlist a Guest is not an existing user:
  - **Join** gives them a normal entry and the status link, like a new email.
  - **Sign-up** with the entry's Invite code (header or invite cookie, gate on) _claims_ their row: a credential account is attached to the same user id, the email is marked verified and the entry is registered. Without a valid code, or with the gate off, core refuses the existing email (422) as before.
  - **Password reset**, while the gate is on, gives a Guest the Gate wouldn't admit no login: no reset mail, and `/reset-password` refuses the credential account (`WAITLIST_INVITE_REQUIRED`). An admitted Guest's reset works and registers the entry; with the gate off, reset is a Guest's way in.
