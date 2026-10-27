// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), access: vi.fn(), configured: vi.fn(), assets: vi.fn(), course: vi.fn(), students: vi.fn(), documents: vi.fn(), files: vi.fn() }));
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.auth }));
vi.mock("@/lib/platform/access", () => ({ canAccessLegacyCourse: mocks.access }));
vi.mock("@/lib/db/client", () => ({ isDatabaseConfigured: mocks.configured, prisma: { fileAsset: { findMany: mocks.assets } } }));
vi.mock("@/lib/showcase/persistence", () => ({ showcaseStore: { loadCourse: mocks.course, listStudents: mocks.students, listDocuments: mocks.documents, listFiles: mocks.files } }));
vi.mock("@/lib/observability/logger", () => ({ logger: { info: vi.fn() } }));

import { GET } from "./route";
const context = { params: Promise.resolve({ courseId: "course" }) };
const request = () => new Request("http://localhost/api/courses/course/showcase/artifacts/export");

describe("showcase archive metadata reads", () => {
  let directory: string;
  const previousUploadDir = process.env.UPLOAD_DIR;
  beforeEach(async () => {
    vi.clearAllMocks();
    directory = await mkdtemp(path.join(tmpdir(), "openpbl-showcase-export-test-"));
    process.env.UPLOAD_DIR = directory;
    mocks.auth.mockResolvedValue({ claims: { sub: "teacher", role: "teacher" } });
    mocks.access.mockResolvedValue(true);
    mocks.configured.mockReturnValue(true);
    mocks.course.mockResolvedValue({ id: "course", name: "Lesson" });
    mocks.students.mockResolvedValue([{ id: "student", name: "Learner" }]);
    mocks.documents.mockResolvedValue([{ studentId: "student", sequence: 2, docxUploadId: "latest" }, { studentId: "student", sequence: 1, docxUploadId: "old" }]);
    mocks.files.mockResolvedValue([{ studentId: "student", sequence: 1, title: "PDF", kind: "pdf", uploadId: "pdf" }, { studentId: "student", sequence: 2, title: "File", kind: "file", uploadId: "file" }]);
    mocks.assets.mockResolvedValue(["latest", "pdf", "file"].map((id) => ({ id, originalName: `${id}.fixture`, storageKey: id })));
    for (const id of ["latest", "pdf", "file"]) await writeFile(path.join(directory, id), `immutable-${id}-bytes`);
  });
  afterEach(async () => {
    if (previousUploadDir === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = previousUploadDir;
    await rm(directory, { recursive: true, force: true });
  });

  it("omits source HTML while preserving latest DOCX and every file archive byte", async () => {
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Server-Timing")).toMatch(/handler;dur=/);
    expect(mocks.documents).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({ sourceHtml: false }) }));
    expect(mocks.assets).toHaveBeenCalledWith({ where: { id: { in: ["latest", "pdf", "file"] }, deletedAt: null }, select: { id: true, originalName: true, storageKey: true } });
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const entries = Object.values(zip.files).filter((entry) => !entry.dir && entry.name !== "成果清单.txt");
    expect(entries).toHaveLength(3);
    expect(await Promise.all(entries.map((entry) => entry.async("string")))).toEqual(["immutable-latest-bytes", "immutable-pdf-bytes", "immutable-file-bytes"]);
    expect(await zip.file("成果清单.txt")!.async("string")).toContain("收集文件数：3");
  });

  it("keeps teacher-only, live permission checks before all metadata and file reads", async () => {
    mocks.auth.mockResolvedValueOnce({ claims: { sub: "student", role: "student" } });
    expect((await GET(request(), context)).status).toBe(403);
    mocks.access.mockResolvedValueOnce(false);
    expect((await GET(request(), context)).status).toBe(403);
    expect(mocks.documents).not.toHaveBeenCalled();
    expect(mocks.assets).not.toHaveBeenCalled();
  });
});
