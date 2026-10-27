// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "@/lib/observability/logger";
import { ACTION_PROXY_STARTED_HEADER, ACTION_PROXY_ENDED_HEADER, NODE_HTTP_RECEIVED_HEADER } from "@/lib/observability/action-entry-timing";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), access: vi.fn(), configured: vi.fn(), version: vi.fn(), projectionAccess: vi.fn(), peerAccess: vi.fn() }));
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.auth }));
vi.mock("@/lib/platform/access", () => ({ canAccessLegacyCourse: mocks.access }));
vi.mock("@/lib/db/client", () => ({ isDatabaseConfigured: mocks.configured, prisma: { artifactVersion: { findFirst: mocks.version } } }));
vi.mock("@/lib/evaluation/pbl-artifact-access", () => ({ canReadPblPeerArtifact: mocks.peerAccess }));
vi.mock("@/lib/showcase/artifact-access", () => ({ canReadActiveShowcaseArtifact: mocks.projectionAccess }));
vi.mock("@/lib/observability/logger", () => ({ logger: { info: vi.fn() } }));

import { GET } from "./route";
const versionId = "11111111-1111-4111-8111-111111111111";
const context = { params: Promise.resolve({ courseId: "course", versionId }) };
const pathname = `/api/courses/course/showcase/artifacts/${versionId}`;
const artifact = { type: "DOCUMENT_ARCHIVE", title: "Private document", participation: { enrollment: { userId: "student" } } };

describe("showcase artifact GET timing and access", () => {
  let directory: string;
  const previousUploadDir = process.env.UPLOAD_DIR;
  beforeEach(async () => {
    vi.clearAllMocks();
    directory = await mkdtemp(path.join(tmpdir(), "openpbl-showcase-artifact-test-"));
    process.env.UPLOAD_DIR = directory;
    mocks.auth.mockResolvedValue({ claims: { sub: "student", role: "student" } });
    mocks.access.mockResolvedValue(true);
    mocks.projectionAccess.mockResolvedValue(false);
    mocks.peerAccess.mockResolvedValue(false);
    mocks.configured.mockReturnValue(true);
    mocks.version.mockResolvedValue({ id: versionId, artifact, sourceHtml: "<p>Private archived evidence</p>", sequence: 4, submittedAt: new Date("2026-10-01T10:00:00Z") });
  });
  afterEach(async () => {
    if (previousUploadDir === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = previousUploadDir;
    await rm(directory, { recursive: true, force: true });
  });

  it("allows the assigned reviewer to read only a submitted pinned version", async () => {
    mocks.version.mockResolvedValue({ id: versionId, artifact: { ...artifact, participation: { enrollment: { userId: "other" } } }, sourceHtml: "<p>Assigned work</p>", sequence: 2 });
    mocks.peerAccess.mockResolvedValue(true);
    const response = await GET(new Request(`http://localhost${pathname}`), context);
    expect(response.status).toBe(200);
    expect(mocks.peerAccess).toHaveBeenCalledWith({ sub: "student", role: "student" }, "course", versionId);
  });

  it("preserves the complete document and fixed route clocks", async () => {
    const epoch = Date.now() - 50;
    const response = await GET(new Request(`http://localhost${pathname}`, { headers: {
      [NODE_HTTP_RECEIVED_HEADER]: String(epoch), [ACTION_PROXY_STARTED_HEADER]: String(epoch + 10), [ACTION_PROXY_ENDED_HEADER]: String(epoch + 20),
    } }), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Server-Timing")).toMatch(/node-dispatch;dur=10\.00.*handler;dur=/);
    await expect(response.json()).resolves.toEqual({ kind: "document", versionId, title: "Private document", sequence: 4, submittedAt: "2026-10-01T10:00:00.000Z", html: "<p>Private archived evidence</p>" });
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ route: "/api/courses/:courseId/showcase/artifacts/:versionId", status: 200 }), "request completed");
    expect(mocks.version).toHaveBeenCalledWith(expect.objectContaining({ where: { id: versionId, status: "SUBMITTED", artifact: { participation: { instanceId: "course" } } } }));
  });

  it("checks live course access before reading and hides another student's version", async () => {
    mocks.access.mockResolvedValueOnce(false);
    expect((await GET(new Request(`http://localhost${pathname}`), context)).status).toBe(403);
    expect(mocks.version).not.toHaveBeenCalled();
    mocks.version.mockResolvedValueOnce({ artifact: { ...artifact, participation: { enrollment: { userId: "other" } } } });
    expect((await GET(new Request(`http://localhost${pathname}`), context)).status).toBe(404);
    mocks.auth.mockResolvedValueOnce({ response: new Response(null, { status: 401 }) });
    expect((await GET(new Request(`http://localhost${pathname}`), context)).status).toBe(401);
  });

  it("preserves actual file bytes, suffix ranges and download headers", async () => {
    const bytes = Buffer.from("0123456789");
    await writeFile(path.join(directory, "fixture.pdf"), bytes);
    mocks.version.mockResolvedValue({ artifact: { ...artifact, type: "PDF_ARCHIVE" }, fileAsset: { storageKey: "fixture.pdf", mimeType: "application/pdf", originalName: "evidence.pdf", deletedAt: null } });
    const response = await GET(new Request(`http://localhost${pathname}?download=1`, { headers: { range: "bytes=-4" } }), context);
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 6-9/10");
    expect(response.headers.get("Content-Length")).toBe("4");
    expect(response.headers.get("Content-Disposition")).toMatch(/^attachment;/);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(6));
    expect((await GET(new Request(`http://localhost${pathname}`, { headers: { range: "bytes=20-30" } }), context)).status).toBe(416);
  });

  it("allows another student's exact currently projected document and revokes it after ending", async () => {
    mocks.version.mockResolvedValue({ id: versionId, artifact: { ...artifact, participation: { enrollment: { userId: "presenter" } } }, sourceHtml: "<p>Shared work</p>" });
    mocks.projectionAccess.mockResolvedValueOnce(true);
    const response = await GET(new Request(`http://localhost${pathname}`), context);
    expect(response.status).toBe(200);
    expect(mocks.projectionAccess).toHaveBeenCalledWith({ sub: "student", role: "student" }, "course", versionId);
    expect((await GET(new Request(`http://localhost${pathname}`), context)).status).toBe(404);
  });
});
