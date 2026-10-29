# How it works

Each email on the list has one **waitlist entry**, with one of four statuses:

- **pending**: in the queue. The **position** comes from the join time (minus any boost), so it's always up to date.
- **approved**: has a live invite. Approving issues an invite code and calls `sendInvite`.
- **registered**: the invite was used to create an account. A registered entry never admits again.
- **rejected**: refused.

| Action                  | From                         | To           |
| ----------------------- | ---------------------------- | ------------ |
| Join                    | (new)                        | `pending`    |
| Approve                 | `pending`, `rejected`        | `approved`   |
| Invite directly         | (new), `pending`, `rejected` | `approved`   |
| Reject                  | `pending`, `approved`        | `rejected`   |
| Requeue                 | `approved`, `rejected`       | `pending`    |
| Sign up with the invite | `approved`                   | `registered` |

Joining sends a **status link** (`sendStatusLink`) to the email. Opening it confirms the inbox and shows the position. A direct invite (`admin.invite`) creates an approved entry straight away.

Deleting a user deletes their entry. To come back, they join again or are invited again.
