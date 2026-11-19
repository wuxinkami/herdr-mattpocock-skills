import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const lookupTimeout = 6_000;

function herdr(args, deadline, socket) {
  const env = { ...process.env };
  for (const key of ['HERDR_SESSION', 'HERDR_SOCKET_PATH', 'HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID']) {
    delete env[key];
  }
  if (socket) env.HERDR_SOCKET_PATH = socket;

  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Herdr 查询超时');
  const result = spawnSync('herdr', args, { env, encoding: 'utf8', timeout: Math.min(remaining, 1_500) });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`herdr ${args.slice(0, 2).join(' ')} 失败（${result.status}）`);
  }
  return result.stdout;
}

function matchingPanes(sessionId, deadline) {
  const { sessions } = JSON.parse(herdr(['session', 'list', '--json'], deadline));
  const matches = [];
  for (const session of sessions.filter(entry => entry.running)) {
    const socket = session.socket_path;
    if (!isAbsolute(socket ?? '')) throw new Error(`Herdr 会话 ${session.name} 缺少绝对 socket 路径`);

    const { agents } = JSON.parse(herdr(['agent', 'list'], deadline, socket)).result;
    for (const agent of agents.filter(entry => entry.agent === 'codex')) {
      const visible = herdr(['pane', 'read', agent.pane_id, '--source', 'visible', '--lines', '6'], deadline, socket);
      if (!visible.split(/\r?\n/).some(line => line.trim() === sessionId)) continue;
      if (!agent.workspace_id || !agent.tab_id || !agent.pane_id || !agent.terminal_id) {
        throw new Error(`Herdr 会话 ${session.name} 的匹配面板缺少坐标`);
      }
      matches.push({
        herdrSession: session.name,
        socket,
        workspace: agent.workspace_id,
        tab: agent.tab_id,
        pane: agent.pane_id,
        terminalId: agent.terminal_id,
      });
    }
  }
  return matches;
}

async function locate(sessionId) {
  const deadline = Date.now() + lookupTimeout;
  let outcome = { status: 'not_found' };
  while (Date.now() < deadline) {
    try {
      const matches = matchingPanes(sessionId, deadline);
      if (matches.length === 1) return { status: 'resolved', address: matches[0] };
      if (matches.length > 1) return { status: 'ambiguous', matches };
      outcome = { status: 'not_found' };
    } catch (error) {
      outcome = { status: 'lookup_error', error: error.message };
    }
    await sleep(Math.max(0, Math.min(200, deadline - Date.now())));
  }
  return outcome;
}

function writeRecord(file, record) {
  const pending = `${file}.tmp`;
  writeFileSync(pending, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(pending, file);
}

const input = JSON.parse(readFileSync(0, 'utf8'));
if (input.hook_event_name !== 'SessionStart' || typeof input.session_id !== 'string' || !uuid.test(input.session_id)) {
  throw new Error('需要带有效 session_id 的 Codex SessionStart JSON');
}

const stateHome = isAbsolute(process.env.XDG_STATE_HOME ?? '') ? process.env.XDG_STATE_HOME : join(homedir(), '.local', 'state');
const recordDir = join(stateHome, 'hms', 'session-start');
mkdirSync(recordDir, { recursive: true, mode: 0o700 });
const recordFile = join(recordDir, `${input.session_id}-${randomUUID()}.json`);
const record = {
  sessionId: input.session_id,
  source: input.source,
  cwd: input.cwd,
  receivedAt: new Date().toISOString(),
};
writeRecord(recordFile, { ...record, status: 'received' });

const outcome = await locate(input.session_id);
writeRecord(recordFile, { ...record, ...outcome, checkedAt: new Date().toISOString() });

const output = {};
if (outcome.status === 'resolved') {
  const { herdrSession, socket, workspace, tab, pane, terminalId } = outcome.address;
  output.hookSpecificOutput = {
    hookEventName: 'SessionStart',
    additionalContext: `当前 Codex 所在的 Herdr 会话是 ${herdrSession}，工作区 ${workspace}，标签页 ${tab}，面板 ${pane}，终端 ID ${terminalId}。Herdr socket 是 ${socket}。`,
  };
}
console.log(JSON.stringify(output));
