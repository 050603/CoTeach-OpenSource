// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ construct: vi.fn() }));
vi.mock("@prisma/client", () => ({ PrismaClient: class { constructor(options: unknown) { mocks.construct(options); } } }));
afterEach(() => {
  globalThis.__openPblPrisma = undefined; globalThis.__openPblProviderPrisma = undefined;
  vi.unstubAllEnvs(); vi.resetModules(); mocks.construct.mockClear();
});
it("reserves the shared connection budget and keeps matching provider configuration on the same client", async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://writer:secret@localhost/classroom?connection_limit=57");
  vi.stubEnv("PROVIDER_CONFIG_DATABASE_URL", process.env.DATABASE_URL!);
  vi.stubEnv("OPENPBL_COURSE_READ_WORKERS", "2"); vi.stubEnv("OPENPBL_COURSE_READ_CONNECTION_BUDGET", "57");
  vi.stubEnv("OPENPBL_COURSE_READ_PER_WORKER_CONNECTIONS", "16");
  vi.stubEnv("OPENPBL_COURSE_READ_DATABASE_URL", "postgresql://reader:other@localhost/classroom");
  const { prisma, providerPrisma } = await import("./client");
  expect(providerPrisma).toBe(prisma); expect(mocks.construct).toHaveBeenCalledOnce();
  const url = new URL(mocks.construct.mock.calls[0][0].datasourceUrl);
  expect(url.searchParams.get("connection_limit")).toBe("25");
  expect(new URL(process.env.DATABASE_URL!).searchParams.get("connection_limit")).toBe("57");
});
