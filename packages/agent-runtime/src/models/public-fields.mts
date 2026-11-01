/** Public metadata must never turn a misplaced credential into a displayed model name. */
export const credentialPattern =
  /(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9_.-]{16,})/i;
export function hasCredential(value: string, secret?: string | null) {
  return (
    credentialPattern.test(value) ||
    Boolean(secret && secret.length >= 8 && value.includes(secret))
  );
}
export function publicText(value: string, secret?: string | null) {
  return hasCredential(value, secret) ? "[已隐藏敏感内容，请重新配置]" : value;
}
