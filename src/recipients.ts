/** Matches a recipient against an app's allowlist. null/undefined list = no restriction. */
export function isRecipientAllowed(email: string, allowlist: string[] | null | undefined): boolean {
  if (!allowlist) return true;
  const addr = email.toLowerCase();
  const domain = addr.slice(addr.lastIndexOf('@'));
  return allowlist.some((entry) => {
    const e = entry.toLowerCase();
    return e.startsWith('@') ? domain === e : addr === e;
  });
}
