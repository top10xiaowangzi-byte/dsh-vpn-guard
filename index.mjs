/**
 * dsh-vpn-guard —— 在 DeepSeek Harness 里操作 v2rayN 订阅守护。
 *
 * Host 半：
 * - 调用工具目录里的 `vpn_guard.py`（纯 Python 标准库）读取结构化状态、启动/停止守护、
 *   刷新订阅、切换最优节点；向本地 Web UI 提供 JSON 接口。
 * - 只读本地 v2rayN 配置/日志，不接触订阅链接与账号信息。
 *
 * Client 半（client.js）：会话标题栏的「VPN」入口 + 状态面板。
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-vpn-guard';
export const inject = ['webServer'];

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const LOCAL_APP_DATA = process.env.LOCALAPPDATA || (HOME ? join(HOME, 'AppData', 'Local') : '');

/** 插件自身所在目录（解析软链接/junction，拿到真实路径）。 */
function resolvePluginDir() {
  const raw = dirname(fileURLToPath(import.meta.url));
  try {
    return realpathSync(raw);
  } catch {
    return raw;
  }
}
const PLUGIN_DIR = resolvePluginDir();

/** 返回第一个存在的候选路径，都不存在时用 fallback。 */
function firstExisting(candidates, fallback) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return fallback;
}

// 工具目录优先取环境变量；否则依次尝试：插件同级目录、用户主目录下的同名目录。
// 不硬编码任何盘符或用户名，换机器只需把工具目录放在插件旁边或设置环境变量。
const TOOL_DIR = process.env.DSH_VPN_GUARD_DIR
  || firstExisting([
    join(PLUGIN_DIR, '..', 'v2rayN自动订阅更新'),
    join(HOME, 'v2rayN自动订阅更新'),
  ], join(HOME, 'v2rayN自动订阅更新'));
const GUARD = join(TOOL_DIR, 'vpn_guard.py');
const LOG_FILE = join(TOOL_DIR, 'logs', 'guard.log');

const PY_CANDIDATES = [
  process.env.DSH_VPN_GUARD_PYTHON,
  ...[14, 13, 12].map((minor) => LOCAL_APP_DATA
    && join(LOCAL_APP_DATA, 'Programs', 'Python', `Python3${minor}`, 'python.exe')),
].filter(Boolean);

const ACTIONS = {
  start: { args: ['--start'], timeoutMs: 120000, title: '启动守护',
           okText: '守护已启动', failText: '启动守护失败' },
  stop: { args: ['--stop'], timeoutMs: 90000, title: '停止守护',
          okText: '守护已停止', failText: '停止守护失败' },
  refresh: { args: ['--refresh-sub'], timeoutMs: 240000, title: '刷新订阅',
             okText: '订阅已刷新', failText: '刷新订阅失败' },
  switch: { args: ['--switch-best'], timeoutMs: 300000, title: '切换节点',
            okText: '已切换到更优节点', failText: '切换节点失败' },
};
// “一键修复” = 刷新订阅 + 切换节点（刷新失败也继续换节点）
const FIX_STEPS = [
  { args: ['--refresh-sub'], label: '刷新订阅' },
  { args: ['--switch-best'], label: '切换节点' },
];

// ---------------------------------------------------------------- 工具执行

let pythonPromise;
function resolvePython() {
  if (pythonPromise) return pythonPromise;
  pythonPromise = (async () => {
    for (const candidate of PY_CANDIDATES) {
      if (candidate && existsSync(candidate)) return candidate;
    }
    try {
      execFileSync('python', ['-c', 'print(1)'], { timeout: 10000, windowsHide: true });
      return 'python';
    } catch {
      /* fall through */
    }
    return null;
  })();
  return pythonPromise;
}

function runPython(args, timeoutMs) {
  return new Promise(async (resolve) => {
    const python = await resolvePython();
    if (!python) {
      resolve({ ok: false, code: -1, stdout: '', stderr: '没有找到 Python，无法调用 vpn_guard.py', timedOut: false });
      return;
    }
    if (!existsSync(GUARD)) {
      resolve({ ok: false, code: -1, stdout: '', stderr: `找不到工具脚本：${GUARD}`, timedOut: false });
      return;
    }
    execFile(
      python,
      [GUARD, ...args],
      {
        cwd: existsSync(TOOL_DIR) ? TOOL_DIR : undefined,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      },
      (error, stdout, stderr) => {
        const timedOut = Boolean(error && error.killed);
        resolve({
          ok: !error,
          code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
          stdout: stdout || '',
          stderr: stderr || '',
          timedOut,
        });
      },
    );
  });
}

function parseJsonFromOutput(stdout) {
  const text = String(stdout || '').replace(/^\uFEFF/, '').trim();
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function tailText(result, maxChars = 1600) {
  const text = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (!text) return '';
  return text.length <= maxChars ? text : `…${text.slice(-maxChars)}`;
}

function lastLines(result, limit = 8) {
  const text = tailText(result, 6000).replace(/\r\n/g, '\n');
  const lines = text.split('\n').filter(Boolean);
  return lines.slice(-limit);
}

// ---------------------------------------------------------------- 状态缓存
const cache = { fast: { at: 0, data: null }, full: { at: 0, data: null } };

async function getStatus(fast) {
  const key = fast ? 'fast' : 'full';
  const ttl = fast ? 8000 : 15000;
  const item = cache[key];
  if (item.data && Date.now() - item.at < ttl) return item.data;
  const args = fast ? ['--json', '--no-health'] : ['--json'];
  const result = await runPython(args, fast ? 30000 : 60000);
  const data = parseJsonFromOutput(result.stdout);
  if (!data) {
    return { ok: false, error: '读取状态失败', detail: lastLines(result, 4), generatedAt: Math.floor(Date.now() / 1000) };
  }
  item.at = Date.now();
  item.data = data;
  return data;
}

function invalidateStatus() {
  cache.fast.at = 0;
  cache.full.at = 0;
}

// ---------------------------------------------------------------- 动作执行
let currentAction = null; // { id, action, title, running, startedAt, finishedAt, ok, message, output }

function startAction(actionName) {
  if (currentAction && currentAction.running) {
    return { ok: false, busy: true, message: `正在执行「${currentAction.title}」，请稍候` };
  }
  const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const begin = (title) => {
    currentAction = { id, action: actionName, title, running: true,
                      startedAt: Math.floor(Date.now() / 1000), finishedAt: null,
                      ok: null, message: '', output: '' };
  };

  const finish = (ok, message, output) => {
    currentAction = { ...currentAction, running: false, ok, message,
                      output: output || '', finishedAt: Math.floor(Date.now() / 1000) };
    invalidateStatus();
  };

  if (actionName === 'fix') {
    begin('一键修复');
    (async () => {
      const outputs = [];
      let switchOk = false;
      let lastFail = '';
      for (const step of FIX_STEPS) {
        const result = await runPython(step.args, 300000);
        outputs.push(`—— ${step.label} ——`, ...lastLines(result, 8));
        if (step.args.includes('--switch-best')) switchOk = result.ok;
        else if (!result.ok) lastFail = `${step.label}失败`;
      }
      const ok = switchOk;
      finish(
        ok,
        ok ? '修复完成：订阅已刷新，已切到可用节点' : `修复未完全成功${lastFail ? `（${lastFail}）` : ''}，可看输出或再点一次`,
        outputs.join('\n'),
      );
    })();
    return { ok: true, action: currentAction };
  }

  const action = ACTIONS[actionName];
  if (!action) return { ok: false, message: `未知操作：${actionName}` };
  begin(action.title);
  (async () => {
    const result = await runPython(action.args, action.timeoutMs);
    finish(
      result.ok,
      result.ok ? action.okText : `${action.failText}${result.timedOut ? '（超时）' : ''}`,
      lastLines(result, 10).join('\n'),
    );
  })();
  return { ok: true, action: currentAction };
}

// ---------------------------------------------------------------- HTTP 工具
function localHost(value) {
  if (typeof value !== 'string') return false;
  return value === 'localhost' || value.startsWith('localhost:')
    || value === '127.0.0.1' || value.startsWith('127.0.0.1:')
    || value === '[::1]' || value.startsWith('[::1]:');
}

function trusted(req) {
  if (!localHost(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return localHost(new URL(origin).host);
  } catch {
    return false;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('request body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}

function readLogTail(lines = 60) {
  try {
    if (!existsSync(LOG_FILE)) return '';
    const text = readFileSync(LOG_FILE, 'utf8');
    return text.replace(/\r\n/g, '\n').split('\n').filter(Boolean).slice(-Math.max(1, Math.min(500, lines))).join('\n');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- 挂载
export function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) =>
    webCtx.effect(() => {
      const disposers = [];

      disposers.push(webCtx.webServer.register({
        kind: 'exact',
        path: '/vpn-guard/status',
        handler: async (req, res) => {
          if (!trusted(req)) { res.writeHead(403); res.end(); return; }
          if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return; }
          try {
            const url = new URL(req.url || '/', 'http://localhost');
            const fast = url.searchParams.get('fast') === '1';
            const status = await getStatus(fast);
            sendJson(res, 200, { ok: true, status, action: currentAction });
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error && error.message || error) });
          }
        },
      }));

      disposers.push(webCtx.webServer.register({
        kind: 'exact',
        path: '/vpn-guard/action',
        handler: async (req, res) => {
          if (!trusted(req)) { res.writeHead(403); res.end(); return; }
          if (req.method === 'GET') {
            sendJson(res, 200, { ok: true, action: currentAction });
            return;
          }
          if (req.method !== 'POST') { res.writeHead(405, { allow: 'GET, POST' }); res.end(); return; }
          try {
            const body = await readJsonBody(req);
            const actionName = String(body.action || '');
            const result = startAction(actionName);
            sendJson(res, result.ok ? 202 : (result.busy ? 409 : 400), {
              ...result,
              action: currentAction,
            });
          } catch (error) {
            sendJson(res, 400, { ok: false, error: String(error && error.message || error) });
          }
        },
      }));

      disposers.push(webCtx.webServer.register({
        kind: 'exact',
        path: '/vpn-guard/log',
        handler: (req, res) => {
          if (!trusted(req)) { res.writeHead(403); res.end(); return; }
          if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return; }
          try {
            const url = new URL(req.url || '/', 'http://localhost');
            const lines = Number(url.searchParams.get('lines') || 60);
            sendJson(res, 200, { ok: true, text: readLogTail(lines), file: LOG_FILE });
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error && error.message || error) });
          }
        },
      }));

      return () => {
        for (const dispose of disposers) {
          try { dispose(); } catch { /* ignore */ }
        }
      };
    }, 'dsh-vpn-guard: web routes'),
  );
}
