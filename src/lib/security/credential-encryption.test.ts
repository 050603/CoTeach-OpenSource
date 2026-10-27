import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptCredential, encryptCredential } from "./credential-encryption";

describe("provider credential encryption", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("round-trips only with the same authenticated context", () => {
    vi.stubEnv("PROVIDER_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    const encrypted = encryptCredential("provider-secret", "teacher:provider");
    expect(encrypted).not.toBeNull();
    expect(decryptCredential(
      encrypted!.ciphertext,
      encrypted!.iv,
      encrypted!.authTag,
      "teacher:provider",
    )).toBe("provider-secret");
    expect(() => decryptCredential(
      encrypted!.ciphertext,
      encrypted!.iv,
      encrypted!.authTag,
      "another-context",
    )).toThrow();
  });

  it("rejects keys that are not exactly 256 bits", () => {
    vi.stubEnv("PROVIDER_ENCRYPTION_KEY", Buffer.alloc(16).toString("base64"));
    expect(() => encryptCredential("secret", "context")).toThrow(
      "PROVIDER_ENCRYPTION_KEY must decode to 32 bytes.",
    );
  });
});
