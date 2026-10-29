# Referrals

Every entry has a public `referralCode`, returned by `status` for share links. Joining with someone's code records them as the referrer. Unknown codes and self-referrals are ignored silently.

When the referred entry reaches `referral.successOn` (by default `"confirm"`, when the referred person confirms their inbox), the plugin calls `onReferralSuccess` **once per entry**. The plugin never rewards anyone on its own. To reward, boost the referrer:

```ts
waitlist({
  onReferralSuccess: async ({ referrer, referralCount }) => {
    // One hour ahead per successful referral, for the first ten.
    if (referralCount <= 10) {
      await auth.api.boostWaitlistEntry({ body: { entryId: referrer.id, seconds: 3600 } })
    }
  },
})
```

Things to know if rewards are worth gaming:

- **Self-referral detection** compares `referral.canonicalizeEmail` forms. The default only strips a `+tag`, so `a.da@gmail.com` can still use `ada@gmail.com`'s code. Pass a stricter function if needed.
- **Once per entry, not per person.** Someone who is deleted and joins again with the same code can succeed again, so dedupe rewards on `referred.email`.
- **The callback is never retried.** The success is recorded before the call. For guaranteed delivery, write to an outbox table in the callback and process it in a job.
- Only `pending` entries can be boosted. Boosting an approved referrer returns 409.
