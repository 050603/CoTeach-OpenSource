/** Safe, stable explanations shared by live failures and recovered receipts. */
export function documentRequestFailureDetails(error?: string): { failureMessage: string; retryable: boolean } {
  switch (error) {
    case "AI_COLLABORATION_TIMEOUT":
      return { failureMessage: "AI 组员这次回答超时了，你的消息已保留。可以重新尝试。", retryable: true };
    case "AI_COLLABORATION_RATE_LIMITED":
    case "AI_PROACTIVE_REVIEW_BUSY":
    case "COURSE_ADMISSION_CONTENDED":
      return { failureMessage: "AI 服务当前请求较多，你的消息已保留。请稍后重新尝试。", retryable: true };
    case "AI_RESPONSE_INVALID_STRUCTURE":
      return { failureMessage: "AI 回答格式暂时不完整，你的消息已保留。可以重新尝试。", retryable: true };
    case "AI_DELEGATED_DELIVERY_INCOMPLETE":
      return { failureMessage: "这次辅助交付在可用修复后仍未通过内容与范围检查，没有修改文稿。你的消息已保留，请调整问题后重新发送。", retryable: false };
    case "AI_DISCUSSION_REVIEW_FAILED":
      return { failureMessage: "这次回答修复后仍未通过事实与推理检查，本次未完成。你的消息已保留，请调整问题后重新发送。", retryable: false };
    case "REQUEST_INTERRUPTED":
      return { failureMessage: "这次回答中断了，你的消息已保留。可以重新尝试。", retryable: true };
    case "REQUEST_ID_CONFLICT":
      return { failureMessage: "这次请求的内容已变化。请编辑后作为新消息发送。", retryable: false };
    case "AI_COLLABORATION_INPUT_REJECTED":
      return { failureMessage: "模型服务未接受这项请求。请编辑原消息，缩小工作范围或调整表述后重新发送。", retryable: false };
    case "CONVERSATION_CHANGED":
    case "REVIEW_SCOPE_CHANGED":
    case "REVIEW_INPUT_CHANGED":
    case "REVIEW_STAGE_CHANGED":
    case "REVIEW_IDENTITY_CHANGED":
    case "REVIEW_IDENTITY_SNAPSHOT_MISSING":
      return { failureMessage: "当前课程或对话已经更新。请回到当前任务后重新发送。", retryable: false };
    case "AI_COLLABORATION_NOT_CONFIGURED":
      return { failureMessage: "AI 服务尚未配置，请联系教师。你的消息已保留。", retryable: false };
    case "REQUEST_STATE_UNAVAILABLE":
    case "REQUEST_RECEIPT_MISSING":
    case "DATABASE_UNAVAILABLE":
      return { failureMessage: "暂时无法确认这次回答的状态，你的消息已保留。请稍后查询或重试。", retryable: true };
    case "AI_COLLABORATION_UPSTREAM_FAILED":
      return { failureMessage: "AI 服务刚才出现短暂波动，你的消息已保留。可以重新尝试。", retryable: true };
    case "DOCUMENT_DELEGATION_HISTORY_UNAVAILABLE":
      return { failureMessage: "暂时无法读取项目协作记录，尚未执行这项工作。你的消息已保留，请稍后重试。", retryable: true };
    default:
      return { failureMessage: "这次回答没能完成，你的消息已保留。可以重新尝试。", retryable: true };
  }
}
