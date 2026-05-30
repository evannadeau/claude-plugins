/**
 * Pure sender-filter decisions for skip-discord. No Discord or fs deps, so the
 * gating logic is unit-testable in isolation from the live bot.
 */

/** True when the message was authored by Skip itself — never react to our own posts. */
export function isOwnMessage(authorId: string, selfId: string | undefined): boolean {
  return selfId !== undefined && authorId === selfId
}

/**
 * True when an author should be dropped because it is an untrusted bot.
 * Humans (isBot=false) are never dropped here; trusted bots in allowBots pass.
 */
export function shouldDropBot(isBot: boolean, authorId: string, allowBots: string[]): boolean {
  return isBot && !allowBots.includes(authorId)
}

/**
 * True when a sender clears the per-channel human gate.
 * Trusted bots bypass the human allowlist; an empty allowFrom means the channel is open.
 */
export function senderPassesGroupGate(
  senderId: string,
  groupAllowFrom: string[],
  allowBots: string[],
): boolean {
  if (allowBots.includes(senderId)) return true
  if (groupAllowFrom.length === 0) return true
  return groupAllowFrom.includes(senderId)
}
