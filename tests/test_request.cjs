const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../app/static/request.js'), 'utf8');

function setup(fetch) {
  const context = vm.createContext({ fetch, AbortController, setTimeout, clearTimeout });
  vm.runInContext(source, context);
  return context.homeRequest;
}
const pending = (signal) => new Promise((_, reject) => {
  if (signal.aborted) reject(new Error('aborted'));
  else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
});

test('a stalled request expires, and the next refresh succeeds', async () => {
  let calls = 0;
  const request = setup((url, options) => ++calls === 1
    ? pending(options.signal) : Promise.resolve({ json: async () => ({ ok: true }) }));
  await assert.rejects(request('/api/devices', { timeoutMs: 15 }), /连接超时/);
  assert.deepEqual(await request('/api/devices'), { ok: true });
});
test('deadline includes a stalled response body', async () => {
  const request = setup(async (url, options) => ({ json: () => pending(options.signal) }));
  await assert.rejects(request('/api/devices', { timeoutMs: 15 }), /连接超时/);
});
test('mutations are not automatically retried on timeout', async () => {
  let calls = 0;
  const request = setup((url, options) => { calls++; return pending(options.signal); });
  await assert.rejects(request('/api/tv/command', { method: 'POST', timeoutMs: 15 }), /确认设备状态/);
  assert.equal(calls, 1);
});
test('caller cancellation is preserved', async () => {
  const controller = new AbortController();
  const request = setup((url, options) => pending(options.signal));
  const response = request('/api/devices', { signal: controller.signal });
  controller.abort();
  await assert.rejects(response, /aborted/);
});
test('successful request clears its timer and uses same-origin credentials', async () => {
  let captured;
  const request = setup(async (url, options) => {
    captured = options;
    return { json: async () => 42 };
  });
  assert.equal(await request('/api/devices', { timeoutMs: 10 }), 42);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(captured.signal.aborted, false);
  assert.equal(captured.credentials, 'same-origin');
  assert.equal(captured.cache, 'no-store');
});
