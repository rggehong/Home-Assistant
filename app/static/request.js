/* Shared by Web and H5. Keep the deadline active while reading the body too. */
async function homeRequest(path, options = {}, read = (response) => response.json()) {
  const { timeoutMs, signal, ...requestOptions } = options;
  const method = (requestOptions.method || "GET").toUpperCase();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  // Device commands (notably standby TV launch) may legitimately take longer.
  const deadline = timeoutMs ?? (method === "GET" ? 30_000 : 120_000);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deadline);
  try {
    const response = await fetch(path, {
      credentials: "same-origin", cache: "no-store", ...requestOptions,
      signal: controller.signal,
    });
    return await read(response);
  } catch (error) {
    if (timedOut) {
      throw new Error(method === "GET"
        ? "连接超时，请检查网络后刷新"
        : "响应超时，请刷新确认设备状态后再操作");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
