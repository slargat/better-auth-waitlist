import type { AuthContext } from "@better-auth/core"
import { queueAfterTransactionHook } from "@better-auth/core/context"

/**
 * Run a host callback: only after the write it
 * describes has committed, scheduled through `runInBackgroundOrAwait`, and
 * wrapped so a throw is logged and never changes the HTTP result.
 *
 * Call it only after the write has succeeded. Every callback goes through here.
 *
 * The log line carries the callback name and the error's name and message (and
 * its causes), never the payload. `secrets` (raw invite codes, status tokens and
 * the URLs that carry them) are redacted from it, because a host mailer's error
 * message can quote what it failed to send.
 */
export async function runCallback(
  context: AuthContext,
  name: string,
  callback: () => Promise<void> | void,
  { secrets = [] }: { secrets?: string[] } = {}
) {
  const run = async () => {
    try {
      await callback()
    } catch (error) {
      logError(context, `${name} callback failed`, error, secrets)
    }
  }
  await queueAfterTransactionHook(async () => {
    await context.runInBackgroundOrAwait(run())
  })
}

/**
 * The one way the plugin logs an error: `[waitlist] <what>: <Name: message>`,
 * with each of `secrets` redacted. Never pass a payload.
 */
export function logError(context: AuthContext, what: string, error: unknown, secrets: string[] = []) {
  context.logger.error(`[waitlist] ${what}: ${redact(describeError(error), secrets)}`)
}

function describeError(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) return typeof error === "string" ? error : "non-Error value thrown"
  const own = `${error.name}: ${error.message}`
  return error.cause !== undefined && depth < 3 ? `${own} (cause: ${describeError(error.cause, depth + 1)})` : own
}

const redact = (text: string, secrets: string[]) =>
  secrets
    .filter((secret) => secret.length > 0)
    .sort((a, b) => b.length - a.length)
    .reduce((out, secret) => out.replaceAll(secret, "[redacted]"), text)
