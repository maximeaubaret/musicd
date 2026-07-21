const CREDENTIAL_KEYS = new Set([
  "apikey",
  "auth",
  "authorization",
  "authtoken",
  "clientsecret",
  "credential",
  "credentials",
  "idtoken",
  "key",
  "lsig",
  "password",
  "passwd",
  "pw",
  "refreshtoken",
  "secret",
  "sessiontoken",
  "sig",
  "signature",
  "token",
  "accesstoken",
  "xembytoken",
  "xmediabrowsertoken",
]);

/**
 * Check whether a field or query-parameter name conventionally carries a credential.
 */
export function isCredentialKey(key: string): boolean {
  let decodedKey = key;
  try {
    decodedKey = decodeURIComponent(key);
  } catch {
    // Invalid percent encoding cannot match a normalized credential key.
  }

  const normalizedKey = decodedKey.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  return CREDENTIAL_KEYS.has(normalizedKey);
}
