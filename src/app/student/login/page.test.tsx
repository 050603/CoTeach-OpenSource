import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import StudentLoginPage from "./page";

describe("student login recovery entry", () => {
  it("links to self-service password reset", () => {
    render(<StudentLoginPage />);
    expect(screen.getByRole("link", { name: "忘记密码？申请重置" })).toHaveAttribute("href", "/student/reset-password");
  });
});
