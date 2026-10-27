import { z } from "zod";

const usernamePattern = /^[a-z0-9._-]+$/;

export const TeacherRegistrationSchema = z
  .object({
    username: z
      .string()
      .trim()
      .min(3, "账号至少需要 3 个字符")
      .max(64, "账号不能超过 64 个字符")
      .transform((value) => value.toLowerCase())
      .refine((value) => usernamePattern.test(value), {
        message: "账号只能包含字母、数字、点、下划线和连字符",
      }),
    displayName: z
      .string()
      .trim()
      .min(1, "请输入教师姓名")
      .max(80, "教师姓名不能超过 80 个字符")
      .transform((value) => value.normalize("NFC")),
    password: z
      .string()
      .min(10, "密码至少需要 10 个字符")
      .max(256, "密码不能超过 256 个字符"),
    confirmPassword: z.string(),
  })
  .refine((value) => value.password === value.confirmPassword, {
    path: ["confirmPassword"],
    message: "两次输入的密码不一致",
  });

export type TeacherRegistrationInput = z.infer<
  typeof TeacherRegistrationSchema
>;
