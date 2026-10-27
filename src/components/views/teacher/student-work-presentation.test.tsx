import type { ComponentProps } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StudentWorkPresentation } from "./student-work-presentation";

type Row = ComponentProps<typeof StudentWorkPresentation>["rows"][number];
const date = "2026-10-18T00:00:00.000Z";
const row: Row = {
  student: { id: "s1", name: "小明", joinedAt: date, stageProgress: {} },
  artifact: { id: "draft", courseId: "course", studentId: "s1", stageKey: "make", type: "document", title: "观察方案", content: "<p>观察&nbsp;数据 &amp; 证据</p>", status: "draft", createdAt: date, updatedAt: date },
  documentVersions: [], externalVersions: [],
};
const version: Row["documentVersions"][number] = { id: "v1", courseId: "course", studentId: "s1", submissionId: "draft", stageKey: "make", sequence: 1, sourceVersion: 1, sourceHtml: "<p>旧版方案</p>", title: "观察方案", status: "submitted", submittedAt: date, createdAt: date };

describe("student work presentation", () => {
  it("shows all students, counts visible characters, and waits for an explicit selection", () => {
    const choose = vi.fn();
    render(<StudentWorkPresentation rows={[row, { ...row, student: { ...row.student, id: "s2", name: "小林" }, artifact: undefined }]} onSelectStudent={choose} />);
    expect(screen.getByRole("button", { name: /小明/ })).toHaveTextContent("未提交7 字");
    expect(screen.getByRole("button", { name: /小林/ })).toHaveTextContent("尚未保存");
    expect(screen.queryByText("观察方案")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /小明/ }));
    expect(choose).toHaveBeenCalledWith("s1");
  });

  it("counts successful versions once without counting draft saves or failed exports", () => {
    const submittedRow = { ...row, artifact: { ...row.artifact!, status: "submitted" as const }, documentVersions: [version, version, { ...version, id: "failed", status: "failed" as const }, { ...version, id: "pending", status: "processing" as const }, { ...version, id: "v2", sequence: 2 }] };
    render(<StudentWorkPresentation rows={[submittedRow]} onSelectStudent={vi.fn()} />);
    expect(screen.getByRole("button", { name: /小明/ })).toHaveTextContent("已提交 2 次");
  });

  it("updates the selected document and word count when classroom data changes", () => {
    const { rerender } = render(<StudentWorkPresentation rows={[row]} selectedStudentId="s1" onSelectStudent={vi.fn()} />);
    expect(within(screen.getByRole("region", { name: "小明的成果内容" })).getByText("观察 数据 & 证据")).toBeTruthy();
    rerender(<StudentWorkPresentation rows={[{ ...row, artifact: { ...row.artifact!, content: "<p>实时保存的新方案</p>" } }]} selectedStudentId="s1" onSelectStudent={vi.fn()} />);
    expect(within(screen.getByRole("region", { name: "小明的成果内容" })).getByText("实时保存的新方案")).toBeTruthy();
    expect(screen.getByRole("button", { name: /小明/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /小明/ })).toHaveTextContent("8 字");
  });

  it("searches the roster without changing the displayed work", () => {
    render(<StudentWorkPresentation rows={[row, { ...row, student: { ...row.student, id: "s2", name: "小林" }, artifact: undefined }]} selectedStudentId="s1" onSelectStudent={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "搜索展示学生" }), { target: { value: "小林" } });
    expect(screen.queryByRole("button", { name: /小明/ })).toBeNull();
    expect(screen.getByRole("button", { name: /小林/ })).toBeTruthy();
    expect(screen.getByRole("region", { name: "小明的成果内容" })).toBeTruthy();
  });

  it("can display a submitted document when there is no current draft", () => {
    render(<StudentWorkPresentation rows={[{ ...row, artifact: undefined, documentVersions: [version] }]} selectedStudentId="s1" onSelectStudent={vi.fn()} />);
    expect(screen.getByText("旧版方案")).toBeTruthy();
    expect(screen.getByText("已提交成果")).toBeTruthy();
    expect(screen.getByRole("button", { name: /小明/ })).toHaveTextContent("4 字");
  });

  it("shows a clear empty state for students without a saved artifact", () => {
    render(<StudentWorkPresentation rows={[{ ...row, artifact: undefined }]} selectedStudentId="s1" onSelectStudent={vi.fn()} />);
    expect(screen.getByText("该学生尚未保存可展示的成果。")).toBeTruthy();
    expect(screen.queryByText("实时成果")).toBeNull();
  });

  it("shows code files and their line count instead of counting the JSON envelope", () => {
    const content = JSON.stringify({ version: 1, language: "python", activeFileId: "main", files: [{ id: "main", path: "main.py", content: "value = 1\nprint(value)\n" }] });
    render(<StudentWorkPresentation rows={[{ ...row, artifact: { ...row.artifact!, type: "code", content } }]} selectedStudentId="s1" onSelectStudent={vi.fn()} />);
    expect(screen.getByRole("button", { name: /小明/ })).toHaveTextContent("2 行代码");
    expect(screen.getByRole("heading", { name: "main.py" })).toBeTruthy();
    expect(screen.getByText(/print\(value\)/)).toBeTruthy();
  });

  it("keeps successful uploaded files available in submission records", () => {
    render(<StudentWorkPresentation rows={[{ ...row, artifact: undefined, externalVersions: [{ id: "upload-v1", courseId: "course", studentId: "s1", stageKey: "make", sequence: 1, title: "节能成果.pdf", uploadId: "upload-file", status: "submitted", createdAt: date, submittedAt: date }] }]} selectedStudentId="s1" onSelectStudent={vi.fn()} />);
    expect(screen.getByRole("button", { name: /小明/ })).toHaveTextContent("已提交 1 次");
    expect(screen.getByRole("button", { name: /小明/ })).toHaveTextContent("文件成果");
    fireEvent.click(screen.getByText("提交记录与文件 · 1 次提交"));
    expect(screen.getByRole("link", { name: "下载文件" })).toHaveAttribute("href", "/api/uploads/upload-file?download=1");
  });
});

it("retains the artifact roster filter and each student's reading position across view switches", () => {
  const rows = [row, { ...row, student: { ...row.student, id: "s2", name: "小林" } }];
  const { rerender } = render(<StudentWorkPresentation rows={rows} selectedStudentId="s1" onSelectStudent={vi.fn()} />);
  fireEvent.change(screen.getByRole("textbox", { name: "搜索展示学生" }), { target: { value: "小明" } });
  const content = screen.getByRole("region", { name: "小明的成果内容" });
  content.scrollTop = 210;
  fireEvent.scroll(content);
  rerender(<StudentWorkPresentation active={false} rows={rows} selectedStudentId="s1" onSelectStudent={vi.fn()} />);
  rerender(<StudentWorkPresentation rows={rows} selectedStudentId="s1" onSelectStudent={vi.fn()} />);
  expect(screen.getByRole("textbox", { name: "搜索展示学生" })).toHaveValue("小明");
  expect(screen.getByRole("region", { name: "小明的成果内容" }).scrollTop).toBe(210);
  rerender(<StudentWorkPresentation rows={rows} selectedStudentId="s2" onSelectStudent={vi.fn()} />);
  expect(screen.getByRole("region", { name: "小林的成果内容" }).scrollTop).toBe(0);
  rerender(<StudentWorkPresentation rows={rows} selectedStudentId="s1" onSelectStudent={vi.fn()} />);
  expect(screen.getByRole("region", { name: "小明的成果内容" }).scrollTop).toBe(210);
});
