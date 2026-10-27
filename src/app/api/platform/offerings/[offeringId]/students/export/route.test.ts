import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), csrf: vi.fn(), archive: vi.fn(), csv: vi.fn() }));
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.auth, requireSameOrigin: mocks.csrf }));
vi.mock("@/lib/platform/repository", () => ({
  PlatformError: class PlatformError extends Error { constructor(public code: string, message: string, public status: number) { super(message); } },
}));
vi.mock("@/lib/platform/student-record-export", () => ({
  STUDENT_RECORD_EXPORT_SECTIONS: ["summary", "activity_progress", "activity_submissions", "classrooms", "artifacts", "reflections", "evaluations", "summary_csv"],
  createStudentRecordsArchive: mocks.archive,
  createStudentRecordsCsv: mocks.csv,
}));

import { POST } from "./route";
import { PlatformError } from "@/lib/platform/repository";

const context = { params: Promise.resolve({ offeringId: "course" }) };
const request = (body: unknown) => new Request("http://localhost/api/platform/offerings/course/students/export", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.csrf.mockReturnValue(null);
  mocks.auth.mockResolvedValue({ claims: { sub: "teacher", role: "teacher" } });
  mocks.archive.mockResolvedValue({ bytes: Buffer.from("zip"), fileName: "课程-学生学习记录.zip" });
  mocks.csv.mockResolvedValue({ bytes: Buffer.from('\uFEFF"姓名","账号"\r\n"小林","student"'), fileName: "课程-学生学习摘要.csv" });
});

describe("student record export endpoint", () => {
  it("returns a private ZIP for the requested students and sections", async () => {
    const response = await POST(request({ enrollmentIds: ["e1", "e2"], sections: ["summary", "evaluations"] }), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/zip");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Disposition")).toContain(encodeURIComponent("课程-学生学习记录.zip"));
    expect(mocks.archive).toHaveBeenCalledWith(expect.anything(), "course", ["e1", "e2"], ["summary", "evaluations"]);
    expect(await response.text()).toBe("zip");
    expect(mocks.csv).not.toHaveBeenCalled();
  });

  it("returns the actual BOM-prefixed CSV bytes with a Chinese attachment name", async () => {
    const response = await POST(request({ format: "csv", enrollmentIds: ["e2", "e1"], sections: ["summary_csv"] }), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Disposition")).toBe(`attachment; filename*=UTF-8''${encodeURIComponent("课程-学生学习摘要.csv")}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(response.headers.get("Content-Length")).toBe(String(bytes.length));
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString("utf8")).toBe('\uFEFF"姓名","账号"\r\n"小林","student"');
    expect(mocks.csv).toHaveBeenCalledWith(expect.anything(), "course", ["e2", "e1"]);
    expect(mocks.archive).not.toHaveBeenCalled();
  });

  it.each([
    { format: "xlsx", enrollmentIds: ["e"], sections: ["summary_csv"] },
    { format: "csv", enrollmentIds: ["e"], sections: ["evaluations"] },
    { format: "csv", enrollmentIds: ["e"], sections: ["summary_csv", "evaluations"] },
    { format: "csv", enrollmentIds: ["e"], sections: [] },
    { format: "csv", enrollmentIds: [], sections: ["summary_csv"] },
  ])("rejects invalid format or selections before loading records: %j", async (body) => {
    expect((await POST(request(body), context)).status).toBe(400);
    expect(mocks.archive).not.toHaveBeenCalled();
    expect(mocks.csv).not.toHaveBeenCalled();
  });

  it("preserves the class authorization and selection errors for CSV", async () => {
    mocks.csv.mockRejectedValueOnce(new PlatformError("FORBIDDEN", "无权查看该教学班", 403));
    expect((await POST(request({ format: "csv", enrollmentIds: ["e"], sections: ["summary_csv"] }), context)).status).toBe(403);
    mocks.csv.mockRejectedValueOnce(new PlatformError("INVALID_INPUT", "导出名单包含不属于当前教学班的学生", 400));
    expect((await POST(request({ format: "csv", enrollmentIds: ["foreign"], sections: ["summary_csv"] }), context)).status).toBe(400);
  });

  it("rejects missing selections before loading records", async () => {
    const response = await POST(request({ enrollmentIds: [], sections: [] }), context);
    expect(response.status).toBe(400);
    expect(mocks.archive).not.toHaveBeenCalled();
  });

  it.each(["zip", "csv"])("honors same-origin and authentication failures for %s", async (format) => {
    mocks.csrf.mockReturnValueOnce(new Response(null, { status: 403 }));
    expect((await POST(request({ format, enrollmentIds: ["e"], sections: ["summary_csv"] }), context)).status).toBe(403);
    mocks.csrf.mockReturnValue(null);
    mocks.auth.mockResolvedValueOnce({ response: new Response(null, { status: 401 }) });
    expect((await POST(request({ format, enrollmentIds: ["e"], sections: ["summary_csv"] }), context)).status).toBe(401);
    expect(mocks.archive).not.toHaveBeenCalled();
    expect(mocks.csv).not.toHaveBeenCalled();
  });
});
