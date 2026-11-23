/**
 * Minimal Chrome DevTools Protocol driver over the `--remote-debugging-pipe`
 * transport (fd 3/4). No external dependencies: the harness runs with plain Node.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_CHROME_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export function findChrome() {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  for (const candidate of DEFAULT_CHROME_PATHS) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    'Could not find Chrome. Set CHROME_PATH to a Chrome/Chromium executable.'
  );
}

/** Launches headless Chrome and attaches to its first page target. */
export async function launchPage({ executablePath = findChrome(), extraArgs = [] } = {}) {
  const userDataDir = path.join(os.tmpdir(), `ikvp-harness-${process.pid}-${Date.now()}`);
  fs.mkdirSync(userDataDir, { recursive: true });

  const child = spawn(
    executablePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      `--user-data-dir=${userDataDir}`,
      '--remote-debugging-pipe',
      ...extraArgs,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] }
  );

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      process.stderr.write(`[chrome exited ${code}]\n${stderr.slice(-2000)}\n`);
    }
  });

  const toBrowser = child.stdio[3];
  const fromBrowser = child.stdio[4];
  if (!toBrowser || !fromBrowser) {
    child.kill('SIGKILL');
    throw new Error('Chrome did not expose the debugging pipe (needs a recent Chrome).');
  }

  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  let buffer = Buffer.alloc(0);

  fromBrowser.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let idx;
    while ((idx = buffer.indexOf(0)) !== -1) {
      let message;
      try {
        message = JSON.parse(buffer.subarray(0, idx).toString('utf8'));
      } catch {
        buffer = buffer.subarray(idx + 1);
        continue;
      }
      buffer = buffer.subarray(idx + 1);
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} ${message.error.data ?? ''}`.trim()));
        else resolve(message.result);
      } else if (message.method) {
        const key = `${message.sessionId ?? ''}:${message.method}`;
        (listeners.get(key) || []).forEach((fn) => fn(message.params));
      }
    }
  });

  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    try {
      toBrowser.write(JSON.stringify(payload) + '\0');
    } catch (err) {
      pending.delete(id);
      reject(err);
    }
  });

  const on = (sessionId, method, fn) => {
    const key = `${sessionId ?? ''}:${method}`;
    if (!listeners.has(key)) listeners.set(key, []);
    listeners.get(key).push(fn);
  };

  const { targetInfos } = await send('Target.getTargets');
  const pageTarget = targetInfos.find((t) => t.type === 'page');
  if (!pageTarget) throw new Error('Chrome started without a page target');

  const { sessionId } = await send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Log.enable', {}, sessionId).catch(() => {});

  const pageErrors = [];
  on(sessionId, 'Runtime.exceptionThrown', (params) => {
    const d = params.exceptionDetails;
    pageErrors.push(d?.exception?.description || d?.text || 'unknown page exception');
  });
  on(sessionId, 'Runtime.consoleAPICalled', (params) => {
    if (params.type === 'error') {
      pageErrors.push(params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
  });

  const evaluate = async (expression, { awaitPromise = true } = {}) => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    }, sessionId);
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      throw new Error(`page evaluation failed: ${d.exception?.description || d.text}`);
    }
    return result.result.value;
  };

  const navigate = async (url) => {
    const loaded = new Promise((resolve) => on(sessionId, 'Page.loadEventFired', resolve));
    await send('Page.navigate', { url }, sessionId);
    await loaded;
  };

  const close = async () => {
    try { await send('Browser.close'); } catch { /* browser may already be gone */ }
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
    });
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  return { send, evaluate, navigate, close, pageErrors, sessionId };
}
