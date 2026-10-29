import type { AuthContext } from "@better-auth/core"

/**
 * The user with `email` (core's lookup, which lowercases) and whether they are
 * a **Guest**: a user with no account rows, so no way to sign in (a host wrote
 * the row outside sign-up, e.g. for a booking or an order). Anyone with at least
 * one account (password or social) is an existing user. Null without a user.
 */
export async function findUser(context: AuthContext, email: string) {
  const found = await context.internalAdapter.findUserByEmail(email, { includeAccounts: true })
  return found && { user: found.user, isGuest: found.accounts.length === 0 }
}
