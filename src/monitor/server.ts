import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadTaskState, listTaskStates } from '../state/state-machine.js';
import type { TaskEvent, TaskRecord } from '../types.js';
import { redactSecrets } from '../utils/exec.js';

const LOCALHOST = '127.0.0.1';
const MAX_TASKS = 100;
const MAX_EVENTS_PER_TASK = 100;
const MAX_RESPONSE_BYTES = 512 * 1024;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface MonitorServerOptions {
  stateDir: string;
  host?: string;
  port?: number;
}

export interface MonitorServerHandle {
  server: http.Server;
  host: string;
  port: number;
  close(): Promise<void>;
}

function securityHeaders(response: http.ServerResponse): void {
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  );
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cache-Control', 'no-store');
}

function send(
  response: http.ServerResponse,
  statusCode: number,
  contentType: string,
  body: string
): void {
  securityHeaders(response);
  response.statusCode = statusCode;
  response.setHeader('Content-Type', contentType);
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.end(body);
}

function safeText(value: unknown, maxLength = 2_000): string | undefined {
  if (typeof value !== 'string') return undefined;
  return redactSecrets(value).slice(0, maxLength);
}

function safeGitHubPullRequestUrl(value: unknown): string | undefined {
  const candidate = safeText(value, 1_000);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      /^\/[^/]+\/[^/]+\/pull\/\d+$/.test(url.pathname)
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function safeEvents(events: TaskEvent[] | undefined): TaskEvent[] {
  return (events || []).slice(-MAX_EVENTS_PER_TASK).map((event) => ({
    timestamp: event.timestamp,
    source: event.source,
    message: safeText(event.message, 500) || 'Event',
    detail: safeText(event.detail, 2_000),
  }));
}

function taskView(task: TaskRecord, detail = false): Record<string, unknown> {
  const basic = {
    id: task.id,
    state: task.state,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    taskBranch: task.taskBranch,
    baseBranch: task.baseBranch,
    prUrl: safeGitHubPullRequestUrl(task.metadata?.prUrl),
    prNumber: task.metadata?.prNumber,
    reviewCycles: task.diagnostics.reviewCycles,
    maxReviewCycles: task.diagnostics.maxReviewCycles,
    lastReviewVerdict: task.diagnostics.lastReviewVerdict,
    lastTestPassed: task.diagnostics.lastTestPassed,
    ciWaitAttempts: task.diagnostics.ciWaitAttempts || 0,
  };

  if (!detail) return basic;
  return {
    ...basic,
    prompt: safeText(task.prompt, 4_000),
    transitions: task.transitions.slice(-MAX_EVENTS_PER_TASK).map((transition) => ({
      from: transition.from,
      to: transition.to,
      timestamp: transition.timestamp,
      reason: safeText(transition.reason, 1_000),
      error: safeText(transition.error, 1_000),
    })),
    diagnostics: {
      lastError: safeText(task.diagnostics.lastError, 2_000),
      resumePossible: task.diagnostics.resumePossible,
      resumeInstructions: safeText(task.diagnostics.resumeInstructions, 1_000),
      worktreePreserved: task.diagnostics.worktreePreserved,
      ciWaitHistory: (task.diagnostics.ciWaitHistory || []).slice(-20).map((entry) => ({
        timestamp: entry.timestamp,
        attempt: entry.attempt,
        status: entry.status,
        summary: safeText(entry.summary, 1_000),
        checks: entry.checks.slice(0, 20).map((check) => ({
          name: safeText(check.name, 200),
          state: safeText(check.state, 100),
          bucket: safeText(check.bucket, 100),
          workflow: safeText(check.workflow, 200),
        })),
      })),
    },
    events: safeEvents(task.events),
  };
}

function json(response: http.ServerResponse, statusCode: number, value: unknown): void {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > MAX_RESPONSE_BYTES) {
    send(
      response,
      413,
      'application/json; charset=utf-8',
      '{"error":"Response exceeds monitor limit"}'
    );
    return;
  }
  send(response, statusCode, 'application/json; charset=utf-8', serialized);
}

const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex + Anti Monitor</title>
  <link rel="stylesheet" href="/assets/monitor.css">
</head>
<body>
  <main class="shell">
    <header class="topbar"><div><p class="eyebrow">LOCAL ORCHESTRATION</p><h1>Codex + Anti</h1></div><p id="connection" class="connection">Connecting</p></header>
    <section class="layout">
      <aside class="task-panel"><h2>Tasks</h2><div id="tasks" class="task-list" aria-live="polite"></div></aside>
      <section class="detail-panel"><div id="empty" class="empty">No task selected. Create a task to start monitoring.</div><div id="detail" hidden></div></section>
    </section>
  </main>
  <script src="/assets/monitor.js"></script>
</body>
</html>`;

const CSS = `:root{color-scheme:light dark;--bg:#f6f8fa;--surface:#fff;--surface-alt:#f0f3f6;--text:#17212b;--muted:#57606a;--line:#d0d7de;--accent:#0969da;--pass:#1a7f37;--warn:#9a6700;--fail:#cf222e;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text)}.shell{max-width:1440px;margin:0 auto;padding:28px}.topbar{display:flex;justify-content:space-between;align-items:end;border-bottom:1px solid var(--line);padding-bottom:22px}.eyebrow{font:600 11px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;color:var(--muted);margin:0 0 8px}.topbar h1{font-size:26px;margin:0;letter-spacing:-.03em}.connection{margin:0;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}.layout{display:grid;grid-template-columns:minmax(260px,340px) 1fr;gap:28px;padding-top:24px}.task-panel{border-right:1px solid var(--line);padding-right:22px}.task-panel h2,.detail-panel h2{font-size:14px;margin:0 0 12px}.task-list{display:grid;gap:8px}.task{display:block;width:100%;border:1px solid var(--line);border-radius:10px;background:var(--surface);padding:13px;text-align:left;color:inherit;cursor:pointer}.task:hover,.task:focus-visible{border-color:var(--accent);outline:2px solid transparent}.task.selected{box-shadow:inset 3px 0 var(--accent);border-color:var(--accent)}.task strong{display:block;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.task small{display:block;color:var(--muted);margin-top:6px}.status{font:600 11px ui-monospace,SFMono-Regular,Menlo,monospace}.status.PASSING,.status.AWAITING_HUMAN_APPROVAL{color:var(--pass)}.status.PENDING,.status.AGY_DEVELOPING,.status.CODEX_REVIEWING{color:var(--warn)}.status.FAILING,.status.FAILED,.status.NEEDS_USER_DECISION{color:var(--fail)}.detail-header{display:flex;justify-content:space-between;gap:16px;align-items:start}.detail-header h2{font:600 20px ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.meta{color:var(--muted);font-size:13px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:24px 0}.metric{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px}.metric span{display:block;color:var(--muted);font-size:12px}.metric strong{display:block;margin-top:8px;font-size:16px}.section{margin-top:26px}.timeline{display:grid;gap:10px}.item{border-left:2px solid var(--line);padding:0 0 0 12px}.item time{display:block;color:var(--muted);font:11px ui-monospace,SFMono-Regular,Menlo,monospace}.item p{margin:4px 0;font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere}.item .source{font:600 11px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--accent)}.empty{border:1px dashed var(--line);border-radius:10px;padding:28px;color:var(--muted)}a{color:var(--accent)}@media (max-width:800px){.shell{padding:18px}.topbar{align-items:start;gap:12px;flex-direction:column}.layout{grid-template-columns:1fr}.task-panel{border-right:0;border-bottom:1px solid var(--line);padding:0 0 20px}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--surface:#161b22;--surface-alt:#21262d;--text:#e6edf3;--muted:#8b949e;--line:#30363d;--accent:#58a6ff;--pass:#3fb950;--warn:#d29922;--fail:#f85149}}`;

const SCRIPT = `let selectedId;const tasks=document.querySelector('#tasks'),detail=document.querySelector('#detail'),empty=document.querySelector('#empty'),connection=document.querySelector('#connection');const text=value=>value==null?'':String(value);const esc=value=>text(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const stamp=value=>value?new Date(value).toLocaleString():'';async function loadTasks(){try{const response=await fetch('/api/tasks',{cache:'no-store'});if(!response.ok)throw new Error('Task list unavailable');const payload=await response.json();connection.textContent='Live local view';tasks.innerHTML=payload.tasks.map(task=>'<button class="task '+(task.id===selectedId?'selected':'')+'" data-id="'+esc(task.id)+'"><strong>'+esc(task.id)+'</strong><small class="status '+esc(task.state)+'">'+esc(task.state)+'</small><small>Updated '+esc(stamp(task.updatedAt))+'</small></button>').join('')||'<div class="empty">No tasks recorded.</div>';tasks.querySelectorAll('[data-id]').forEach(button=>button.addEventListener('click',()=>{selectedId=button.dataset.id;loadTasks();loadDetail()}));if(!selectedId&&payload.tasks[0]){selectedId=payload.tasks[0].id;loadTasks();loadDetail()}}catch(error){connection.textContent='Disconnected';tasks.innerHTML='<div class="empty">'+esc(error.message)+'</div>'}}async function loadDetail(){if(!selectedId)return;try{const response=await fetch('/api/tasks/'+encodeURIComponent(selectedId),{cache:'no-store'});if(!response.ok)throw new Error('Task detail unavailable');const task=await response.json();empty.hidden=true;detail.hidden=false;const events=(task.events||[]).map(event=>'<article class="item"><time>'+esc(stamp(event.timestamp))+'</time><span class="source">'+esc(event.source)+'</span><p>'+esc(event.message)+(event.detail?'\\n'+esc(event.detail):'')+'</p></article>').join('')||'<div class="empty">No agent events recorded yet.</div>';const transitions=(task.transitions||[]).map(item=>'<article class="item"><time>'+esc(stamp(item.timestamp))+'</time><p><strong>'+esc(item.from)+' → '+esc(item.to)+'</strong>'+((item.reason||item.error)?'\\n'+esc(item.reason||item.error):'')+'</p></article>').join('')||'<div class="empty">No transitions.</div>';detail.innerHTML='<div class="detail-header"><div><h2>'+esc(task.id)+'</h2><p class="meta">Branch: '+esc(task.taskBranch)+'</p></div><span class="status '+esc(task.state)+'">'+esc(task.state)+'</span></div><div class="grid"><div class="metric"><span>Review cycles</span><strong>'+esc(task.reviewCycles)+' / '+esc(task.maxReviewCycles)+'</strong></div><div class="metric"><span>Codex review</span><strong>'+esc(task.lastReviewVerdict||'Pending')+'</strong></div><div class="metric"><span>Local tests</span><strong>'+esc(task.lastTestPassed===undefined?'Pending':task.lastTestPassed?'Passed':'Failed')+'</strong></div><div class="metric"><span>CI polls</span><strong>'+esc(task.ciWaitAttempts)+'</strong></div></div>'+(task.prUrl?'<p><a href="'+esc(task.prUrl)+'" rel="noreferrer" target="_blank">Open pull request</a></p>':'')+'<section class="section"><h2>Agent event feed</h2><div class="timeline">'+events+'</div></section><section class="section"><h2>State timeline</h2><div class="timeline">'+transitions+'</div></section>'}catch(error){empty.hidden=false;detail.hidden=true;empty.textContent=error.message}}loadTasks();setInterval(()=>{loadTasks();loadDetail()},3000);`;

export function createMonitorHttpServer(stateDir: string): http.Server {
  return http.createServer(async (request, response) => {
    if (!request.url || request.method !== 'GET') {
      send(response, 405, 'text/plain; charset=utf-8', 'Method not allowed');
      return;
    }
    const pathname = new URL(request.url, `http://${LOCALHOST}`).pathname;
    if (pathname === '/') return send(response, 200, 'text/html; charset=utf-8', HTML);
    if (pathname === '/favicon.ico') return send(response, 204, 'image/x-icon', '');
    if (pathname === '/assets/monitor.css')
      return send(response, 200, 'text/css; charset=utf-8', CSS);
    if (pathname === '/assets/monitor.js')
      return send(response, 200, 'text/javascript; charset=utf-8', SCRIPT);
    try {
      if (pathname === '/api/tasks') {
        const taskList = await listTaskStates(stateDir);
        return json(response, 200, {
          tasks: taskList.slice(0, MAX_TASKS).map((task) => taskView(task)),
        });
      }
      const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (taskMatch) {
        let taskId: string;
        try {
          taskId = decodeURIComponent(taskMatch[1] || '');
        } catch {
          return json(response, 400, { error: 'Invalid task id' });
        }
        if (!TASK_ID_PATTERN.test(taskId)) return json(response, 400, { error: 'Invalid task id' });
        const task = await loadTaskState(stateDir, taskId);
        if (!task) return json(response, 404, { error: 'Task not found' });
        return json(response, 200, taskView(task, true));
      }
    } catch {
      return json(response, 500, { error: 'Monitor data is unavailable' });
    }
    send(response, 404, 'text/plain; charset=utf-8', 'Not found');
  });
}

export async function startMonitorServer(
  options: MonitorServerOptions
): Promise<MonitorServerHandle> {
  const host = options.host || LOCALHOST;
  if (host !== LOCALHOST && host !== 'localhost') {
    throw new Error('Monitor may only bind to localhost.');
  }
  const server = createMonitorHttpServer(options.stateDir);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4390, LOCALHOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    host: LOCALHOST,
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  };
}
