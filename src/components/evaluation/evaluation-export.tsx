"use client";

import { useState } from "react";
import type { PblEvaluationSnapshot } from "@/lib/evaluation/pbl-contract";
import styles from "./evaluation.module.css";

/** Download only the role-projected snapshot already authorized by the API. */
export function downloadEvaluationSnapshot(snapshot: PblEvaluationSnapshot) {
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `pbl-evaluation-${snapshot.instanceId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${snapshot.role}.json`;
  document.body.append(anchor);
  try { anchor.click(); }
  finally { anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1_000); }
}

export function EvaluationExport({ snapshot }: { snapshot: PblEvaluationSnapshot }) {
  const [error, setError] = useState("");
  return <div>
    <button className={styles.button} type="button" onClick={() => {
      try { downloadEvaluationSnapshot(snapshot); setError(""); }
      catch { setError("导出未完成，请重试。"); }
    }}>导出评价 JSON</button>
    <p className={styles.muted}>{snapshot.role === "teacher" ? "导出全班档案，包含教师可见的未发布个人记录。" : "导出当前可查看的个人评价与互评任务。"}</p>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
  </div>;
}
