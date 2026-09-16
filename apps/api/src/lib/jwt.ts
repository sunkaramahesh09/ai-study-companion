/**
 * Reads the `sub` claim out of a JWT WITHOUT verifying the signature.
 *
 * This is safe only because nothing trusts the result on its own. The claim is
 * used to pick which `profiles` row to ask for; the query itself goes through
 * the caller's RLS-scoped client, so Postgres verifies the signature, the
 * expiry and the issuer before returning anything. A forged or expired token
 * yields no row, and the request is rejected.
 *
 * Do not use this value for an authorization decision without a database
 * round trip that revalidates the token.
 */
export function unsafeDecodeSubject(token: string): string | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as {
      sub?: unknown;
    };
    return typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : undefined;
  } catch {
    return undefined;
  }
}
