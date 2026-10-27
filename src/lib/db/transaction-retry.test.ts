// @vitest-environment node

import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { isRetryableTransactionError } from "./transaction-retry";

function prismaError(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError("database error", {
    code,
    clientVersion: "test",
    meta,
  });
}

describe("transaction retry classification", () => {
  it("retries Prisma write conflicts", () => {
    expect(isRetryableTransactionError(prismaError("P2034"))).toBe(true);
  });

  it("retries PostgreSQL serialization failures and deadlocks", () => {
    expect(
      isRetryableTransactionError(prismaError("P2010", { code: "40001" })),
    ).toBe(true);
    expect(
      isRetryableTransactionError(prismaError("P2010", { code: "40P01" })),
    ).toBe(true);
  });

  it("does not retry validation or application errors", () => {
    expect(isRetryableTransactionError(prismaError("P2002"))).toBe(false);
    expect(isRetryableTransactionError(new Error("invalid input"))).toBe(false);
  });
});
