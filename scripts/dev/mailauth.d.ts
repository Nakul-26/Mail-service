// Minimal typing for the part of mailauth used by the DKIM checks (dev/test only).
declare module 'mailauth/lib/dkim/verify.js' {
  export function dkimVerify(
    raw: Buffer,
    opts: { resolver: (name: string, type: string) => Promise<string[][]> },
  ): Promise<{ results: { signingDomain?: string; status?: { result?: string } }[] }>;
}
