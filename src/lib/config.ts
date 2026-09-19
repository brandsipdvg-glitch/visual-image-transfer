// Shared secret used by sender and receiver when no key UI is shown. Both
// sides must derive the same key schedule, so this must never diverge.
export const DEFAULT_KEY = "vit-shared-default-key";