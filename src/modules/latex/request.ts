/** Sanitized transport error; never carry response bodies or credentials. */
export class ModelRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs = 0,
  ) {
    super(message);
    this.name = "ModelRequestError";
  }
}

export function modelRequestFailure(
  status: number,
  retryAfter: string | null = null,
  now = Date.now(),
) {
  const retryable =
    !status ||
    [408, 425, 429].includes(status) ||
    (status >= 500 && status < 600);
  const seconds = retryAfter?.trim();
  const delay = seconds
    ? /^\d+(?:\.\d+)?$/.test(seconds)
      ? Number(seconds) * 1000
      : Date.parse(seconds) - now
    : 0;
  const retryAfterMs = Number.isFinite(delay)
    ? Math.max(0, Math.min(delay, 30000))
    : 0;
  return new ModelRequestError(
    `模型请求失败${status ? `（HTTP ${status}）` : "（网络连接或超时）"}。${retryable ? "服务暂不可用。" : "请检查 API 密钥、模型名称及服务地址。"}`,
    retryable,
    retryAfterMs,
  );
}

/** Transport retries stay separate from content validation and batch splitting. */
export async function retryModelRequest<T>(
  request: () => Promise<T>,
  pause: (milliseconds: number) => Promise<void>,
  check: () => void,
  update: (message: string) => void,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    check();
    try {
      const result = await request();
      check();
      return result;
    } catch (error) {
      check();
      if (
        !(error instanceof ModelRequestError) ||
        !error.retryable ||
        attempt >= 2
      )
        throw error;
      const delay = Math.max(1000 * 2 ** attempt, error.retryAfterMs);
      update(
        `${error.message}等待 ${delay / 1000} 秒后重试请求（${attempt + 2}/3）。`,
      );
      await pause(delay);
    }
  }
}
