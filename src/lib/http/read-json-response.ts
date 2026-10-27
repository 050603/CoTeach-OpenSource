export async function readJsonResponse<T>(
  response: Response,
  fallbackMessage = "服务暂时没有返回可读取的内容，请稍后重试。",
): Promise<T> {
  const text = await response.text();
  if (!text.trim()) {
    throw new Error(fallbackMessage);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      response.ok
        ? "服务返回的数据格式异常，请稍后重试。"
        : `请求未完成（${response.status}），请稍后重试。`,
    );
  }
}
