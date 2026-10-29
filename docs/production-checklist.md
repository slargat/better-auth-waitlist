# Production checklist

- **Set `advanced.backgroundTasks.handler`** (for example `waitUntil` on Cloudflare Workers or Vercel) if you send emails from the callbacks or use `gate.joinOnBlockedSignUp`. Without it, a join that sends mail is slower than one that doesn't, which reveals who is on the list, and serverless runtimes may drop the background work. The plugin warns at startup.
- **Use a database that enforces unique indexes.** Duplicate joins are rejected by the unique index on `email`. Better Auth's memory adapter doesn't enforce it (the plugin warns).
- **Prefer an adapter with transactions.** Inside a transaction (email sign-up and OAuth on most adapters), the invite is claimed atomically. Without one (magic link, email OTP, or drizzle's default `transaction: false`), single-use relies on the code being bound to one email and on the unique index on `user.email`.
- **Make sure someone can manage the list**: install the admin plugin, or set `admin.canManage`.
