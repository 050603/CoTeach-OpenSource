// 客户端 UUID 生成。
//
// crypto.randomUUID() 仅在安全上下文(HTTPS 或 localhost)可用;通过内网 IP
// 直访(如 http://172.16.x.x)属于非安全上下文,该函数不存在,会让创建课程
// 等操作静默抛错。crypto.getRandomValues 在非安全上下文仍然可用,用它拼装
// 标准 UUID v4 —— 服务端 zod schema(z.string().uuid())会拒绝非 UUID 形状。
type BrowserCrypto = {
  randomUUID?: () => string;
  getRandomValues: (array: Uint8Array) => Uint8Array;
};

export function clientUUID(): string {
  const c = globalThis.crypto as BrowserCrypto | undefined;
  if (typeof c?.randomUUID === "function") {
    return c.randomUUID();
  }
  const bytes = new Uint8Array(16);
  (c as BrowserCrypto).getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
