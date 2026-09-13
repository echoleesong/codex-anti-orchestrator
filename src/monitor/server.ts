import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { checkGitCleanliness, checkGitLockfile } from '../git/git-utils.js';
import { loadTaskState, listTaskStates } from '../state/state-machine.js';
import type { TaskEvent, TaskRecord } from '../types.js';
import { defaultExecutor, redactSecrets } from '../utils/exec.js';

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

function safeLoopbackUrl(value: unknown): string | undefined {
  const candidate = safeText(value, 500);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function safeGitHubUrl(value: unknown): string | undefined {
  const candidate = safeText(value, 1_000);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' && url.hostname === 'github.com' ? url.toString() : undefined;
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

function safeReviewFeedback(task: TaskRecord): Record<string, unknown> | undefined {
  const feedback = task.metadata?.lastFeedback;
  if (!feedback || typeof feedback !== 'object' || Array.isArray(feedback)) return undefined;
  const value = feedback as {
    blockingIssues?: unknown;
    warnings?: unknown;
    testErrors?: unknown;
  };
  const list = (items: unknown, maxItems: number) =>
    Array.isArray(items)
      ? items
          .slice(0, maxItems)
          .map((item) => safeText(item, 1_000))
          .filter(Boolean)
      : [];
  return {
    blockingIssues: list(value.blockingIssues, 20),
    warnings: list(value.warnings, 20),
    testErrors: safeText(value.testErrors, 2_000),
  };
}

async function worktreeSnapshot(task: TaskRecord): Promise<Record<string, unknown>> {
  const checkedAt = new Date().toISOString();
  const [cleanliness, lock, revision] = await Promise.all([
    checkGitCleanliness(task.worktreePath, defaultExecutor),
    checkGitLockfile(task.worktreePath, defaultExecutor),
    defaultExecutor('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: task.worktreePath,
      timeoutMs: 5_000,
    }),
  ]);

  const error =
    cleanliness.error || lock.error || revision.stderr.trim() || revision.error?.message;
  return {
    status: lock.locked ? 'LOCKED' : error ? 'UNAVAILABLE' : cleanliness.clean ? 'CLEAN' : 'DIRTY',
    checkedAt,
    commit: revision.exitCode === 0 ? safeText(revision.stdout.trim(), 64) : undefined,
    changedFileCount: Math.min(cleanliness.uncommitted.length, 100),
    lockDetected: lock.locked,
    error: safeText(error, 500),
  };
}

async function taskView(task: TaskRecord, detail = false): Promise<Record<string, unknown>> {
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
  const snapshot = await worktreeSnapshot(task);
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
      gitSafety: snapshot,
      reviewFeedback: safeReviewFeedback(task),
      humanVerificationChecklist: (task.diagnostics.humanVerificationChecklist || [])
        .slice(0, 12)
        .map((item) => safeText(item, 500))
        .filter(Boolean),
      liveVerification: task.diagnostics.liveVerification
        ? {
            status: task.diagnostics.liveVerification.status,
            command: safeText(task.diagnostics.liveVerification.command, 500),
            url: safeLoopbackUrl(task.diagnostics.liveVerification.url),
            checks: task.diagnostics.liveVerification.checks
              .slice(0, 20)
              .map((item) => safeText(item, 500))
              .filter(Boolean),
            summary: safeText(task.diagnostics.liveVerification.summary, 2_000),
          }
        : undefined,
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
          description: safeText(check.description, 500),
          link: safeGitHubUrl(check.link),
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
  <title>Codex + Anti 本机监控</title>
  <link rel="stylesheet" href="/assets/monitor.css">
</head>
<body>
  <main class="shell">
    <header class="topbar"><div><p class="eyebrow">本机协作编排</p><h1>Codex + Anti 任务监控</h1></div><p id="connection" class="connection">正在连接</p></header>
    <section class="layout">
      <aside class="task-panel"><h2>任务列表</h2><div id="tasks" class="task-list" aria-live="polite"></div></aside>
      <section class="detail-panel"><div id="empty" class="empty">尚未选择任务。创建任务后将在此处显示监控信息。</div><div id="detail" hidden></div></section>
    </section>
  </main>
  <script src="/assets/monitor.js"></script>
</body>
</html>`;

const CSS = `:root{color-scheme:light dark;--bg:#f6f8fa;--surface:#fff;--surface-alt:#f0f3f6;--text:#17212b;--muted:#57606a;--line:#d0d7de;--accent:#0969da;--pass:#1a7f37;--warn:#9a6700;--fail:#cf222e;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text)}.shell{max-width:1440px;margin:0 auto;padding:28px}.topbar{display:flex;justify-content:space-between;align-items:end;border-bottom:1px solid var(--line);padding-bottom:22px}.eyebrow{font:600 11px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;color:var(--muted);margin:0 0 8px}.topbar h1{font-size:26px;margin:0;letter-spacing:-.03em}.connection{margin:0;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}.layout{display:grid;grid-template-columns:minmax(260px,340px) 1fr;gap:28px;padding-top:24px}.task-panel{border-right:1px solid var(--line);padding-right:22px}.task-panel h2,.detail-panel h2{font-size:14px;margin:0 0 12px}.task-list{display:grid;gap:8px}.task{display:block;width:100%;border:1px solid var(--line);border-radius:10px;background:var(--surface);padding:13px;text-align:left;color:inherit;cursor:pointer}.task:hover,.task:focus-visible{border-color:var(--accent);outline:2px solid transparent}.task.selected{box-shadow:inset 3px 0 var(--accent);border-color:var(--accent)}.task strong{display:block;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.task small{display:block;color:var(--muted);margin-top:6px}.status{font:600 11px ui-monospace,SFMono-Regular,Menlo,monospace}.status.PASSING,.status.AWAITING_HUMAN_APPROVAL{color:var(--pass)}.status.PENDING,.status.AGY_DEVELOPING,.status.AGY_VALIDATING,.status.CODEX_REVIEWING{color:var(--warn)}.status.FAILING,.status.FAILED,.status.NEEDS_USER_DECISION{color:var(--fail)}.detail-header{display:flex;justify-content:space-between;gap:16px;align-items:start}.detail-header h2{font:600 20px ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.meta{color:var(--muted);font-size:13px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:24px 0}.metric{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px}.metric span{display:block;color:var(--muted);font-size:12px}.metric strong{display:block;margin-top:8px;font-size:16px}.section{margin-top:26px}.timeline{display:grid;gap:10px}.item{border-left:2px solid var(--line);padding:0 0 0 12px}.item time{display:block;color:var(--muted);font:11px ui-monospace,SFMono-Regular,Menlo,monospace}.item p{margin:4px 0;font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere}.item .source{font:600 11px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--accent)}.checklist{margin:0;padding-left:20px;display:grid;gap:6px;font-size:13px}.empty{border:1px dashed var(--line);border-radius:10px;padding:28px;color:var(--muted)}.notice{border:1px solid var(--line);border-radius:10px;background:var(--surface-alt);padding:14px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}.notice.warn{border-color:var(--warn)}.notice.fail{border-color:var(--fail)}.notice.pass{border-color:var(--pass)}.subheading{font-size:12px;color:var(--muted);margin:16px 0 8px}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:10px}.table{width:100%;border-collapse:collapse;font-size:12px}.table th,.table td{padding:9px 10px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}.table th{background:var(--surface-alt);color:var(--muted);font-weight:600}.table tr:last-child td{border-bottom:0}.copy{border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text);padding:8px 10px;cursor:pointer;font-size:12px}.copy:hover,.copy:focus-visible{border-color:var(--accent)}a{color:var(--accent)}@media (max-width:800px){.shell{padding:18px}.topbar{align-items:start;gap:12px;flex-direction:column}.layout{grid-template-columns:1fr}.task-panel{border-right:0;border-bottom:1px solid var(--line);padding:0 0 20px}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--surface:#161b22;--surface-alt:#21262d;--text:#e6edf3;--muted:#8b949e;--line:#30363d;--accent:#58a6ff;--pass:#3fb950;--warn:#d29922;--fail:#f85149}}`;

const SCRIPT = `let selectedId;
const tasks=document.querySelector('#tasks'),detail=document.querySelector('#detail'),empty=document.querySelector('#empty'),connection=document.querySelector('#connection');
const text=value=>value==null?'':String(value);
const esc=value=>text(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stamp=value=>value?new Date(value).toLocaleString('zh-CN'):'';
const labels={IDLE:'空闲',INITIALIZING:'正在初始化',WORKTREE_PREPARING:'正在准备隔离工作区',WORKTREE_READY:'隔离工作区已就绪',AGY_DEVELOPING:'Anti 正在开发',PR_CREATING:'正在创建拉取请求',CODEX_REVIEWING:'Codex 正在审查',REVIEW_EVALUATING:'正在评估审查结果',AGY_VALIDATING:'Anti 正在本机验证',AGY_FIXING:'Anti 正在修复',PR_UPDATING:'正在更新拉取请求',AWAITING_HUMAN_APPROVAL:'等待人工核验',NEEDS_USER_DECISION:'需要人工决策',AWAITING_HUMAN_OVERRIDE:'等待人工风险放行',COMPLETED:'已完成',FAILED:'已失败',ABORTED:'已取消',APPROVE:'通过',CHANGES_REQUIRED:'需要修改',PASSED:'通过',PENDING:'等待中',PASSING:'通过中',FAILING:'失败',UNAVAILABLE:'不可用',CLEAN:'干净',DIRTY:'存在未提交变更',LOCKED:'检测到 Git 锁',ORCHESTRATOR:'协调器',ANTI:'Anti 开发',CODEX:'Codex 审查',GITHUB_CI:'GitHub CI'};
const label=value=>labels[value]||text(value);
const list=items=>'<ul class="checklist">'+items.map(item=>'<li>'+esc(item)+'</li>').join('')+'</ul>';
const localizeEvent=message=>{
  const fixed={
    'Task accepted and isolated worktree allocation started.':'已接收任务，开始分配隔离工作区。',
    'Development request dispatched to Antigravity.':'已向 Anti 发送开发任务。',
    'Antigravity development invocation completed.':'Anti 开发调用已完成。',
    'No changes were committed; PR creation halted.':'没有可提交的变更，已停止创建拉取请求。',
    'Pull request created.':'拉取请求已创建。',
    'Live verification request dispatched with Codex review checklist.':'已向 Anti 发送携带 Codex 核验清单的本机验证请求。',
    'Live verification left the worktree non-clean; human decision required.':'本机验证后工作区并非干净状态，需要人工决策。'
  };
  if(fixed[message])return fixed[message];
  let match=message.match(/^CI observation (\\d+)\\/(\\d+): (.+)$/);
  if(match)return '第 '+match[1]+' / '+match[2]+' 次 CI 状态检查：'+label(match[3]);
  match=message.match(/^Codex review completed with verdict: (.+)\\.$/);
  if(match)return 'Codex 审查已完成，结论：'+label(match[1]);
  match=message.match(/^Live verification completed with status: (.+)\\.$/);
  if(match)return '本机运行验证已完成，状态：'+label(match[1]);
  return message;
};
const duration=milliseconds=>{const seconds=Math.max(0,Math.floor(milliseconds/1000));if(seconds<60)return seconds+' 秒';const minutes=Math.floor(seconds/60);if(minutes<60)return minutes+' 分钟';const hours=Math.floor(minutes/60);const rest=minutes%60;return hours+' 小时'+(rest?' '+rest+' 分钟':'');};
const stateAge=task=>duration(Date.now()-new Date(task.updatedAt).getTime());
const feedbackPanel=feedback=>{if(!feedback)return '<div class="empty">当前没有已记录的审查反馈。</div>';const group=(title,items)=>items&&items.length?'<h3 class="subheading">'+title+'</h3>'+list(items):'';return group('阻断项',feedback.blockingIssues)+group('警告项',feedback.warnings)+(feedback.testErrors?'<h3 class="subheading">测试错误摘要</h3><div class="notice fail">'+esc(feedback.testErrors)+'</div>':'')||'<div class="empty">当前没有阻断项或警告项。</div>';};
const ciPanel=history=>{const latest=history&&history.length?history[history.length-1]:undefined;if(!latest)return '<div class="empty">尚无 CI 观察记录。</div>';const rows=(latest.checks||[]).map(check=>'<tr><td>'+esc(check.workflow||'—')+'</td><td>'+esc(check.name)+'</td><td>'+esc(label(check.bucket||check.state))+'</td><td>'+esc(check.description||'—')+(check.link?' <a href="'+esc(check.link)+'" target="_blank" rel="noreferrer">查看</a>':'')+'</td></tr>').join('')||'<tr><td colspan="4">本次未返回 CI 检查项。</td></tr>';return '<p class="meta">第 '+esc(latest.attempt)+' 次检查 · '+esc(stamp(latest.timestamp))+' · '+esc(label(latest.status))+'</p><p class="notice">'+esc(latest.summary||'暂无摘要')+'</p><div class="table-wrap"><table class="table"><thead><tr><th>工作流</th><th>检查项</th><th>状态</th><th>说明</th></tr></thead><tbody>'+rows+'</tbody></table></div>';};
const blockerFor=task=>{const diagnostics=task.diagnostics||{},feedback=diagnostics.reviewFeedback||{},latestCi=(diagnostics.ciWaitHistory||[]).at(-1);if(task.state==='FAILED')return {level:'fail',text:'任务失败。'+(diagnostics.lastError||diagnostics.resumeInstructions||'请查看状态记录并处理失败原因。')};if(task.state==='NEEDS_USER_DECISION')return {level:'fail',text:'需要人工决策。'+(diagnostics.lastError||diagnostics.resumeInstructions||'自动化流程已停止，等待你的处理。')};if(task.state==='AWAITING_HUMAN_OVERRIDE')return {level:'warn',text:'存在已知风险，正在等待人工风险放行。'};if(task.state==='AWAITING_HUMAN_APPROVAL')return {level:'pass',text:'自动化检查与本机验证已通过，等待人工最终核验和合并。'};if((feedback.blockingIssues||[]).length)return {level:'warn',text:'Codex 审查发现 '+feedback.blockingIssues.length+' 项阻断问题，Anti 将继续修复或等待人工决策。'};if(task.lastTestPassed===false)return {level:'fail',text:'本地自动化测试未通过。'};if(latestCi&&latestCi.status!=='PASSING')return {level:'warn',text:'CI 当前状态：'+label(latestCi.status)+'。'};return {level:'warn',text:'当前没有明确阻断项，任务正在“'+label(task.state)+'”阶段运行。'};};
const copyDiagnostic=async(task,blocker,button)=>{const safety=task.diagnostics?.gitSafety||{};const lines=['任务 ID：'+task.id,'当前状态：'+label(task.state),'阻断摘要：'+blocker.text,'审查轮次：'+task.reviewCycles+' / '+task.maxReviewCycles,'Codex 审查：'+label(task.lastReviewVerdict||'PENDING'),'本地测试：'+(task.lastTestPassed===undefined?'等待中':task.lastTestPassed?'通过':'失败'),'工作区状态：'+label(safety.status||'UNAVAILABLE'),'最新提交：'+(safety.commit||'未获取'),'PR：'+(task.prUrl||'未创建')];try{await navigator.clipboard.writeText(lines.join('\\n'));button.textContent='已复制安全摘要';setTimeout(()=>button.textContent='复制安全诊断摘要',1800)}catch{button.textContent='复制失败';setTimeout(()=>button.textContent='复制安全诊断摘要',1800)}};
async function loadTasks(){try{const response=await fetch('/api/tasks',{cache:'no-store'});if(!response.ok)throw new Error();const payload=await response.json();connection.textContent='本机实时视图';tasks.innerHTML=payload.tasks.map(task=>'<button class="task '+(task.id===selectedId?'selected':'')+'" data-id="'+esc(task.id)+'"><strong>'+esc(task.id)+'</strong><small class="status '+esc(task.state)+'">'+esc(label(task.state))+'</small><small>更新时间：'+esc(stamp(task.updatedAt))+'</small></button>').join('')||'<div class="empty">暂无已记录的任务。</div>';tasks.querySelectorAll('[data-id]').forEach(button=>button.addEventListener('click',()=>{selectedId=button.dataset.id;loadTasks();loadDetail()}));if(!selectedId&&payload.tasks[0]){selectedId=payload.tasks[0].id;loadTasks();loadDetail()}}catch(error){connection.textContent='连接已断开';tasks.innerHTML='<div class="empty">无法获取任务列表，请确认本机监控服务仍在运行。</div>'}}
async function loadDetail(){if(!selectedId)return;try{const response=await fetch('/api/tasks/'+encodeURIComponent(selectedId),{cache:'no-store'});if(!response.ok)throw new Error();const task=await response.json();empty.hidden=true;detail.hidden=false;const diagnostics=task.diagnostics||{},safety=diagnostics.gitSafety||{},blocker=blockerFor(task),events=(task.events||[]).map(event=>'<article class="item"><time>'+esc(stamp(event.timestamp))+'</time><span class="source">'+esc(label(event.source))+'</span><p>'+esc(localizeEvent(event.message))+(event.detail?'\\n'+esc(event.detail):'')+'</p></article>').join('')||'<div class="empty">暂无代理事件记录。</div>',transitions=(task.transitions||[]).map(item=>'<article class="item"><time>'+esc(stamp(item.timestamp))+'</time><p><strong>'+esc(label(item.from))+' → '+esc(label(item.to))+'</strong>'+((item.reason||item.error)?'\\n'+esc(item.reason||item.error):'')+'</p></article>').join('')||'<div class="empty">暂无状态流转记录。</div>',verification=diagnostics.liveVerification,verificationDetail=verification?'<p class="meta">'+esc(label(verification.status))+' · '+esc(verification.summary)+'</p>'+(verification.command?'<p class="meta">启动命令：'+esc(verification.command)+'</p>':'')+(verification.url?'<p class="meta">已核验的本机地址（核验后服务已停止）：'+esc(verification.url)+'</p>':'')+list(verification.checks||[]):'<div class="empty">正在等待 Anti 对本地开发环境进行验证。</div>';detail.innerHTML='<div class="detail-header"><div><h2>'+esc(task.id)+'</h2><p class="meta">任务分支：'+esc(task.taskBranch)+' · 已运行 '+esc(duration(Date.now()-new Date(task.createdAt).getTime()))+' · 当前状态已持续 '+esc(stateAge(task))+'</p></div><div><span class="status '+esc(task.state)+'">'+esc(label(task.state))+'</span><button id="copy-diagnostic" class="copy" type="button">复制安全诊断摘要</button></div></div><section class="section"><h2>阻断摘要与下一步</h2><div class="notice '+esc(blocker.level)+'">'+esc(blocker.text)+(diagnostics.resumeInstructions?'\\n建议操作：'+esc(diagnostics.resumeInstructions):'')+'</div></section><div class="grid"><div class="metric"><span>审查轮次</span><strong>'+esc(task.reviewCycles)+' / '+esc(task.maxReviewCycles)+'</strong></div><div class="metric"><span>Codex 审查</span><strong>'+esc(label(task.lastReviewVerdict||'PENDING'))+'</strong></div><div class="metric"><span>本地测试</span><strong>'+esc(task.lastTestPassed===undefined?'等待中':task.lastTestPassed?'通过':'失败')+'</strong></div><div class="metric"><span>CI 查询次数</span><strong>'+esc(task.ciWaitAttempts)+'</strong></div><div class="metric"><span>工作区状态</span><strong>'+esc(label(safety.status||'UNAVAILABLE'))+'</strong></div><div class="metric"><span>未提交变更</span><strong>'+esc(safety.changedFileCount??'—')+'</strong></div><div class="metric"><span>Git 锁</span><strong>'+esc(safety.lockDetected?'已检测到':'未检测到')+'</strong></div><div class="metric"><span>最新提交</span><strong>'+esc(safety.commit||'未获取')+'</strong></div></div>'+(task.prUrl?'<p><a href="'+esc(task.prUrl)+'" rel="noreferrer" target="_blank">打开拉取请求</a></p>':'')+'<section class="section"><h2>Codex 审查反馈</h2>'+feedbackPanel(diagnostics.reviewFeedback)+'</section><section class="section"><h2>CI 明细</h2>'+ciPanel(diagnostics.ciWaitHistory)+'</section><section class="section"><h2>Codex 人工核验要点</h2>'+list(diagnostics.humanVerificationChecklist||[])+'</section><section class="section"><h2>Anti 本机运行验证</h2>'+verificationDetail+'</section><section class="section"><h2>代理事件记录</h2><div class="timeline">'+events+'</div></section><section class="section"><h2>状态流转记录</h2><div class="timeline">'+transitions+'</div></section>';const copyButton=document.querySelector('#copy-diagnostic');if(copyButton)copyButton.addEventListener('click',()=>copyDiagnostic(task,blocker,copyButton));}catch(error){empty.hidden=false;detail.hidden=true;empty.textContent='无法读取任务详情，请稍后重试。'}}
loadTasks();setInterval(()=>{loadTasks();loadDetail()},3000);`;

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
          tasks: await Promise.all(taskList.slice(0, MAX_TASKS).map((task) => taskView(task))),
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
        return json(response, 200, await taskView(task, true));
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
