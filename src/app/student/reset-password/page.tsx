"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Badge, Lock, RefreshCw, UserRound } from "lucide-react";
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, PASSWORD_LENGTH_HINT } from "@/lib/auth/password-policy";
import { StudentAuthShell } from "@/components/platform/student-auth-shell";

type ResetRequest = {
  id: string; username: string; displayName: string;
  state: "pending" | "approved" | "expired" | "used" | "cancelled";
  createdAt: string; expiresAt: string; approvedAt: string | null;
};
const requestUrl = "/api/platform/auth/password-reset-request";
function requestTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function StudentResetPasswordPageContent() {
  const search = useSearchParams();
  const [request, setRequest] = useState<ResetRequest | null>(null);
  const [checked, setChecked] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const actionBusy = useRef(false);
  const readController = useRef<AbortController | null>(null);

  const checkRequest = useCallback(async () => {
    if (actionBusy.current || readController.current) return;
    const controller = new AbortController();
    readController.current = controller;
    setRefreshing(true);
    try {
      const response = await fetch(requestUrl, { cache: "no-store", signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "无法检查申请状态，请重试");
      if (!controller.signal.aborted) { setRequest(data.request); setChecked(true); setReadError(null); }
    } catch (reason) {
      if (!controller.signal.aborted) setReadError(reason instanceof Error ? reason.message : "网络错误，请检查连接后重试");
    } finally {
      if (readController.current === controller) { readController.current = null; setRefreshing(false); }
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Fetch the browser-bound application on page entry.
    void checkRequest();
    return () => { readController.current?.abort(); readController.current = null; };
  }, [checkRequest]);
  useEffect(() => {
    if (done || (request?.state !== "pending" && request?.state !== "approved")) return;
    const checkVisible = () => { if (document.visibilityState === "visible") void checkRequest(); };
    const timer = setInterval(checkVisible, 5000);
    document.addEventListener("visibilitychange", checkVisible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", checkVisible); };
  }, [checkRequest, done, request?.state]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (actionBusy.current) return;
    const resetting = request?.state === "approved";
    if (resetting && password !== confirmPassword) { setError("两次输入的密码不一致"); return; }
    actionBusy.current = true;
    readController.current?.abort(); readController.current = null; setRefreshing(false);
    setBusy(true); setError(null);
    try {
      const response = await fetch(resetting ? "/api/platform/auth/reset-password" : requestUrl, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(resetting ? { password } : { username, displayName }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? (resetting ? "无法重置密码，请检查申请状态" : "无法提交申请，请核对学号和姓名"));
      if (resetting) { setPassword(""); setConfirmPassword(""); setDone(true); }
      else { setRequest(data.request); setChecked(true); setReadError(null); }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "网络错误，请稍后重试");
    } finally { actionBusy.current = false; setBusy(false); }
  }

  const completed = done || request?.state === "used";
  const canApply = checked && (!request || request.state === "expired" || request.state === "cancelled");
  return <StudentAuthShell title={completed ? "密码已更新" : request?.state === "approved" ? "设置新密码" : "申请重置密码"}>
    {search.has("token") && !completed ? <p className="pbl-auth-notice mb-5">旧重置链接已停用，请在此页重新提交申请。</p> : null}
    {completed ? <>
      <p role="status" className="pbl-auth-success">密码已更新，请使用新密码登录。</p>
      <button type="button" className="mt-4 inline-flex min-h-11 items-center text-sm text-[var(--pbl-student)] underline" onClick={() => {
        setUsername(request?.username ?? username); setDisplayName(request?.displayName ?? displayName);
        setRequest(null); setDone(false); setChecked(true); setError(null); setReadError(null);
        setPassword(""); setConfirmPassword("");
      }}>再次申请重置</button>
    </> : <>
      {!checked && !readError ? <p role="status" className="text-sm text-[var(--pbl-text-muted)]">正在检查当前浏览器的申请…</p> : null}
      {request ? <section aria-label="当前重置申请" className="mb-5 grid gap-2 text-sm leading-6">
        <p className="font-medium">{request.displayName} · {request.username}</p>
        <p className="text-[var(--pbl-text-muted)]">申请编号：{request.id.slice(0, 8)} · 提交于 {requestTime(request.createdAt)}</p>
        <p role="status" className={request.state === "approved" ? "pbl-auth-success" : "pbl-auth-notice"}>
          {request.state === "pending" ? "申请已提交，等待任课教师核实并允许重置。请向教师说明本人学号和本次申请编号。" : request.state === "approved" ? "教师已允许重置，请在有效期内设置新密码。" : request.state === "expired" ? "申请已过期，请重新提交。" : "申请已取消，如仍需重置，请重新提交。"}
        </p>
        {(request.state === "pending" || request.state === "approved") ? <p className="text-[var(--pbl-text-muted)]">有效至 {requestTime(request.expiresAt)}。请保留此浏览器，教师允许后只能在提交申请的浏览器设置密码。</p> : null}
      </section> : null}
      {canApply || request?.state === "approved" ? <form className="pbl-auth-fields" onSubmit={submit} aria-busy={busy}>
        {canApply ? <>
          <p className="text-sm leading-6 text-[var(--pbl-text-muted)]">填写学号和姓名提交申请。教师核实本人身份并允许后，在此浏览器设置新密码。</p>
          <label className="pbl-auth-field"><span>学号</span><span className="pbl-auth-input-wrap"><UserRound aria-hidden="true" className="pbl-auth-input-icon" size={17}/><input className="pbl-auth-input" autoComplete="username" maxLength={64} placeholder="输入你的学号" required value={username} onChange={event => setUsername(event.target.value)}/></span></label>
          <label className="pbl-auth-field"><span>姓名</span><span className="pbl-auth-input-wrap"><Badge aria-hidden="true" className="pbl-auth-input-icon" size={17}/><input className="pbl-auth-input" autoComplete="name" maxLength={64} placeholder="输入注册时的姓名" required value={displayName} onChange={event => setDisplayName(event.target.value)}/></span></label>
        </> : <>
          <label className="pbl-auth-field"><span>新密码</span><span className="pbl-auth-input-wrap"><Lock aria-hidden="true" className="pbl-auth-input-icon" size={17}/><input className="pbl-auth-input" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} placeholder={PASSWORD_LENGTH_HINT} required type="password" value={password} onChange={event => setPassword(event.target.value)}/></span></label>
          <label className="pbl-auth-field"><span>确认新密码</span><span className="pbl-auth-input-wrap"><Lock aria-hidden="true" className="pbl-auth-input-icon" size={17}/><input className="pbl-auth-input" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} placeholder="再次输入新密码" required type="password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)}/></span></label>
        </>}
        <button className="pbl-auth-primary" disabled={busy} type="submit"><span>{busy ? "正在提交…" : canApply ? "提交重置申请" : "保存新密码"}</span><ArrowRight aria-hidden="true" size={18}/></button>
      </form> : null}
      {error ? <p className="pbl-auth-error mt-4" role="alert">{error}</p> : null}
      {readError ? <p className="pbl-auth-error mt-4" role="alert">{readError}</p> : null}
      {(request || readError || error) ? <button type="button" disabled={busy || refreshing} onClick={() => void checkRequest()} className="mt-4 flex min-h-11 items-center gap-2 text-sm text-[var(--pbl-student)]"><RefreshCw aria-hidden="true" size={16}/>{refreshing ? "检查中…" : "检查申请状态"}</button> : null}
    </>}
    <Link href="/student/login" className="pbl-auth-back-link"><ArrowLeft aria-hidden="true" size={16}/>返回登录</Link>
  </StudentAuthShell>;
}

export default function StudentResetPasswordPage() {
  return <Suspense fallback={<main className="grid min-h-screen place-items-center bg-[var(--pbl-bg)] text-sm text-[var(--pbl-text-muted)]"><p role="status">正在打开学习空间…</p></main>}><StudentResetPasswordPageContent/></Suspense>;
}
