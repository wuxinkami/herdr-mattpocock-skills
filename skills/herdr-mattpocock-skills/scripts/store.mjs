import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const stateFile = project => path.join(project, '.agents', 'herdr', 'state', 'hms.sqlite3');
const shortId = (kind, value) => kind + ':' + crypto.createHash('sha256').update(value).digest('base64url').slice(0, 12);
export const roundKey = (project, record) => shortId('rnd', path.relative(project, record).split(path.sep).join('/'));

const schema = `
CREATE TABLE IF NOT EXISTS rounds (
  id TEXT PRIMARY KEY,
  record TEXT NOT NULL UNIQUE,
  context TEXT,
  snapshot TEXT,
  secretary TEXT
);
CREATE TABLE IF NOT EXISTS members (
  seq INTEGER PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES rounds(id),
  session_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  role TEXT,
  identity TEXT NOT NULL,
  UNIQUE (round_id, tool, session_id)
);
CREATE TABLE IF NOT EXISTS tasks (
  round_id TEXT NOT NULL REFERENCES rounds(id),
  task TEXT NOT NULL,
  PRIMARY KEY (round_id, task)
);
CREATE TABLE IF NOT EXISTS runs (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  round_id TEXT NOT NULL,
  task TEXT NOT NULL,
  role TEXT NOT NULL,
  tool TEXT NOT NULL,
  carrier TEXT NOT NULL,
  cwd TEXT NOT NULL,
  prompt TEXT NOT NULL,
  config TEXT,
  parent TEXT,
  panel TEXT,
  session_id TEXT,
  actual_tool TEXT,
  startup TEXT NOT NULL,
  status TEXT,
  summary TEXT,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (round_id, task) REFERENCES tasks(round_id, task)
);
CREATE INDEX IF NOT EXISTS runs_by_round ON runs(round_id, seq);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  result TEXT,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  delivered_at TEXT
);
`;

// Fixed SQL templates use the same text encoding for Node's SQLite and the CLI fallback.
function sql(parts, ...values) {
  return parts.reduce((query, part, i) => {
    if (i === 0) return part;
    const value = values[i - 1];
    const literal = value == null ? 'NULL' : "CAST(X'" + Buffer.from(value).toString('hex') + "' AS TEXT)";
    return query + literal + part;
  }, '');
}

function openState(file) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(path.join(dir, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  fs.closeSync(fs.openSync(file, 'a', 0o600));
}

function access(project, { write, query, create } = {}) {
  const file = stateFile(project);
  if (create) openState(file);
  else if (!fs.existsSync(file)) return [];
  const pragmas = 'PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;';
  // A read can encounter a file just created by the first writer.
  const transaction = `${pragmas} BEGIN IMMEDIATE; ${schema}\n${write ?? ''}`;
  const Database = process.getBuiltinModule?.('node:sqlite')?.DatabaseSync;
  if (Database) {
    const db = new Database(file);
    try {
      db.exec('PRAGMA busy_timeout = 10000;');
      db.exec(transaction);
      const rows = query ? db.prepare(query).all() : [];
      db.exec('COMMIT;');
      return rows;
    } finally {
      db.close();
    }
  }
  const res = spawnSync('sqlite3', ['-batch', '-bail', '-json', '-init', process.platform === 'win32' ? 'NUL' : '/dev/null', file], {
    input: `.timeout 10000\n${transaction}\n${query ? query + ';' : ''}\nCOMMIT;\n`,
    encoding: 'utf8', maxBuffer: Infinity,
  });
  if (res.error?.code === 'ENOENT') throw new Error('团队台账需要 Node.js 的 node:sqlite，或 PATH 中的 sqlite3 CLI（3.38+）');
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(res.stderr.trim() || 'SQLite 未完成操作');
  return res.stdout.trim() ? JSON.parse(res.stdout) : [];
}

function memberInsert(id, member) {
  const { sessionId, tool, model, effort, role, identity } = member;
  return sql`INSERT INTO members (round_id, session_id, tool, model, effort, role, identity)
    VALUES (${id}, ${sessionId}, ${tool}, ${model}, ${effort}, ${role}, ${identity})
    ON CONFLICT (round_id, tool, session_id) DO UPDATE SET
      model = CASE WHEN members.model = '未核实' THEN excluded.model ELSE members.model END,
      effort = CASE WHEN members.effort = '未核实' THEN excluded.effort ELSE members.effort END,
      identity = CASE WHEN members.role IS NULL THEN excluded.identity ELSE members.identity END,
      role = coalesce(members.role, excluded.role);`;
}

export function getRound(project, id) {
  const [round] = access(project, { query: sql`SELECT * FROM rounds WHERE id = ${id}` });
  if (round) {
    round.record = path.join(project, round.record);
    round.snapshot = JSON.parse(round.snapshot);
    round.secretary = JSON.parse(round.secretary);
  }
  return round;
}

export function putRound(project, { id, record, context, snapshot, secretary }, members = [], mode = 'import') {
  const insert = sql`INSERT INTO rounds (id, record, context, snapshot, secretary)
    VALUES (${id}, ${path.relative(project, record)}, ${context}, ${JSON.stringify(snapshot)}, ${JSON.stringify(secretary)})`;
  const update = mode === 'create' ? '' : mode === 'update'
    ? ' ON CONFLICT (id) DO UPDATE SET context = excluded.context, snapshot = excluded.snapshot, secretary = coalesce(excluded.secretary, rounds.secretary)'
    : ` ON CONFLICT (id) DO UPDATE SET context = coalesce(rounds.context, excluded.context),
        snapshot = coalesce(rounds.snapshot, excluded.snapshot), secretary = coalesce(rounds.secretary, excluded.secretary)`;
  access(project, { create: true, write: insert + update + ';\n' + members.map(m => memberInsert(id, m)).join('\n') });
}

export function roundMembers(project, id) {
  return access(project, { query: sql`SELECT session_id AS sessionId, tool, model, effort, role, identity
    FROM members WHERE round_id = ${id} ORDER BY seq` });
}

export function addMember(project, id, member) {
  access(project, { write: memberInsert(id, member) });
}

export function startRun(project, round, run) {
  const id = shortId('run', crypto.randomUUID());
  const { task, role, tool, carrier, cwd, prompt, config, parent } = run;
  access(project, { write: sql`
    INSERT OR IGNORE INTO tasks (round_id, task) VALUES (${round}, ${task});
    INSERT INTO runs (id, round_id, task, role, tool, carrier, cwd, prompt, config, parent, startup)
      VALUES (${id}, ${round}, ${task}, ${role}, ${tool}, ${carrier}, ${cwd}, ${prompt},
        ${JSON.stringify(config)}, ${JSON.stringify(parent)}, 'starting');` });
  return { id, round };
}

const fields = {
  panel: 'panel', parent: 'parent', sessionId: 'session_id', actualTool: 'actual_tool',
  startup: 'startup', status: 'status', summary: 'summary', result: 'result', error: 'error',
};

export function updateRun(project, run, changes, member) {
  const setters = Object.entries(changes).map(([key, value]) => {
    if (!Object.hasOwn(fields, key)) throw new Error(`未知执行记录字段 ${key}`);
    return fields[key] + sql` = ${['panel', 'parent'].includes(key) && value != null ? JSON.stringify(value) : value}`;
  });
  const update = setters.length ? `UPDATE runs SET ${setters.join(', ')}` + sql` WHERE id = ${run.id};` : '';
  access(project, { write: update + (member ? memberInsert(run.round, member) : '') });
}

function decodeRun(run) {
  if (!run) return;
  const { round_id: round, session_id: sessionId, actual_tool: actualTool, created_at: createdAt, ...rest } = run;
  return { ...rest, round, sessionId, actualTool, createdAt, config: JSON.parse(run.config),
    parent: JSON.parse(run.parent), panel: JSON.parse(run.panel) };
}

export function getRun(project, id) {
  const [run] = access(project, { query: sql`SELECT * FROM runs WHERE id = ${id}` });
  return decodeRun(run);
}

export function roundRuns(project, id) {
  return access(project, { query: sql`SELECT * FROM runs WHERE round_id = ${id} ORDER BY seq` }).map(decodeRun);
}

export function closePanel(project, panel) {
  const { socket, pane, terminal } = panel;
  access(project, { write: sql`UPDATE runs SET panel = json_set(panel, '$.closed', json('true'))
    WHERE json_extract(panel, '$.socket') = ${socket} AND json_extract(panel, '$.pane') = ${pane}
      AND json_extract(panel, '$.terminal') = ${terminal};` });
}

export function recordReport(project, run, { status, summary, result }) {
  const id = shortId('msg', JSON.stringify([run, status, summary, result]));
  const [report] = access(project, { write: sql`
    INSERT OR IGNORE INTO reports (id, run_id, status, summary, result)
      VALUES (${id}, ${run}, ${status}, ${summary}, ${result});
    UPDATE runs SET status = ${status}, summary = ${summary}, result = ${result}
      WHERE id = ${run} AND changes() = 1;`,
  query: sql`SELECT id, delivered_at AS deliveredAt FROM reports WHERE id = ${id}` });
  return report;
}

export function markDelivered(project, report) {
  access(project, { write: sql`UPDATE reports SET delivered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ${report} AND delivered_at IS NULL;` });
}

export function pendingReports(project, id) {
  return access(project, { query: sql`SELECT reports.id, run_id AS run, task, role, reports.status, reports.summary, reports.result
    FROM reports JOIN runs ON runs.id = reports.run_id
    WHERE runs.round_id = ${id} AND delivered_at IS NULL ORDER BY recorded_at, reports.rowid` });
}
