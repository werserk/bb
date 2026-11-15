/**
 * werserk fork: a thread waits for its owner when a provider interaction is
 * pending or a persistent question card is open.
 */
export function threadNeedsOwnerAttention(thread: {
  hasPendingInteraction?: boolean;
  hasOpenQuestion?: boolean;
}): boolean {
  return (
    thread.hasPendingInteraction === true || thread.hasOpenQuestion === true
  );
}
