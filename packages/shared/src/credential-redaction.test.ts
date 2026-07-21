import { describe, expect, test } from "bun:test";

import { isCredentialKey } from "./credential-redaction";

describe("credential key classification", () => {
  test("recognizes common credential field and query names", () => {
    for (const key of [
      "password",
      "api_key",
      "AccessToken",
      "client-secret",
      "X-MediaBrowser-Token",
      "signature",
      "sig",
      "%61pi_key",
    ]) {
      expect(isCredentialKey(key)).toBe(true);
    }
  });

  test("keeps non-credential request context visible", () => {
    for (const key of ["quality", "limit", "itemId", "method"]) {
      expect(isCredentialKey(key)).toBe(false);
    }
  });
});
