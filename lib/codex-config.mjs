import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';
import { shellQuote } from '../skills/herdr-mattpocock-skills/scripts/hms.mjs';

const THREAD_ID = 'thread-id';
const DEFAULT_STATUS_LINE = ['model-with-reasoning', 'current-dir', 'thread-name'];
const HOOK_STATUS = 'HMS 核对 Herdr 面板坐标';

function readFile(file) {
  try {
    const dest = fs.realpathSync(file);
    return { file, dest, text: fs.readFileSync(dest, 'utf8'), mode: fs.statSync(dest).mode & 0o777 };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { file, dest: file, text: null, mode: 0o600 };
  }
}

function readToml(file) {
  const entry = readFile(file);
  const source = (entry.text ?? '').replace(/^\uFEFF/, '');
  try {
    const ast = parseTOML(source);
    const statusLine = getStaticTOMLValue(ast).tui?.status_line;
    if (statusLine !== undefined && (!Array.isArray(statusLine) || statusLine.some(item => typeof item !== 'string'))) {
      throw new Error('tui.status_line 应是字符串数组');
    }
    return { ...entry, source, ast, statusLine };
  } catch (error) {
    const location = error.lineNumber ? `:${error.lineNumber}` : '';
    throw new Error(`无法合并 Codex 配置 ${file}${location}，请检查 TOML 和 tui.status_line`);
  }
}

function keyIs(node, ...expected) {
  const keys = node.key.keys;
  return keys.length === expected.length && keys.every((key, index) => (key.name ?? key.value) === expected[index]);
}

function updateStatusArray(source, tokens, array) {
  const start = array.range[0] + 1;
  const [first] = array.elements;
  const removals = new Map();
  for (const item of array.elements) {
    if (item === first || item.value !== THREAD_ID) continue;
    const index = tokens.findIndex(token => token.range[0] === item.range[0]);
    const next = tokens[index + 1];
    const comma = next.value === ',' ? next : tokens[index - 1];
    removals.set(...item.range);
    removals.set(...comma.range);
  }
  for (const [from, to] of [...removals].sort(([a], [b]) => b - a)) {
    source = source.slice(0, from) + source.slice(to);
  }
  if (first?.value === THREAD_ID) return source;
  const separator = !first ? '' : /\s/.test(source[start]) ? ',' : ', ';
  return source.slice(0, start) + '"thread-id"' + separator + source.slice(start);
}

function addThreadId({ source, ast }, inherited) {
  const root = ast.body[0].body;
  const values = root.filter(node => node.type === 'TOMLKeyValue');
  const table = root.find(node => node.type === 'TOMLTable' && node.kind === 'standard' && keyIs(node, 'tui'));
  const inline = values.find(node => keyIs(node, 'tui'))?.value;
  const setting = values.find(node => keyIs(node, 'tui', 'status_line'))
    ?? (table?.body ?? inline?.body)?.find(node => keyIs(node, 'status_line'));
  if (setting) return updateStatusArray(source, ast.tokens, setting.value);
  const items = inherited ?? DEFAULT_STATUS_LINE;
  const array = [THREAD_ID, ...items.filter(item => item !== THREAD_ID)].map(item => JSON.stringify(item));
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const line = `status_line = [${array.join(', ')}]`;
  if (table) {
    const end = source.indexOf('\n', table.range[0]);
    if (end === -1) return source + eol + line + eol;
    return source.slice(0, end + 1) + line + eol + source.slice(end + 1);
  }
  if (inline?.type === 'TOMLInlineTable') {
    const start = inline.range[0] + 1;
    return source.slice(0, start) + ` ${line}${inline.body.length ? ',' : ' '}` + source.slice(start);
  }
  if (values.some(node => node.key.keys.length > 1 && (node.key.keys[0].name ?? node.key.keys[0].value) === 'tui')) {
    return `tui.${line}${eol}${source}`;
  }
  const prefix = source && !source.endsWith('\n') ? source + eol : source;
  return `${prefix}${prefix ? eol : ''}[tui]${eol}${line}${eol}`;
}

export function codexHookCommand(script, platform = process.platform) {
  if (platform !== 'win32') return `node ${shellQuote(script)}`;
  // cmd.exe expands %variables% even inside quotes. An encoded file URL needs no shell path escaping.
  const url = Buffer.from(pathToFileURL(script).href).toString('base64url');
  return `node -e "import(Buffer.from('${url}','base64url').toString('utf8'))"`;
}

function ownsHook(hook) {
  return hook?.type === 'command' && hook.statusMessage === HOOK_STATUS;
}

function readHooks(dir) {
  const entry = readFile(path.join(dir, 'hooks.json'));
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  try {
    const doc = entry.text === null ? {} : JSON.parse(entry.text.replace(/^\uFEFF/, ''));
    if (!object(doc) || (doc.hooks !== undefined && !object(doc.hooks))) throw new Error();
    const groups = doc.hooks?.SessionStart;
    if (groups !== undefined && (!Array.isArray(groups) || groups.some(group => !Array.isArray(group?.hooks)))) throw new Error();
    return { ...entry, doc, groups: groups ?? [] };
  } catch {
    throw new Error(`无法合并 Codex hook ${entry.file}，请检查 JSON 和 hooks.SessionStart`);
  }
}

function changeHooks(entry, handler) {
  const groups = [];
  for (const group of entry.groups) {
    const hooks = group.hooks.filter(hook => !ownsHook(hook));
    if (hooks.length === group.hooks.length) groups.push(group);
    else if (hooks.length) groups.push({ ...group, hooks });
  }
  if (handler) groups.push({ matcher: 'startup|resume|clear|fork', hooks: [handler] });
  if (JSON.stringify(entry.groups) === JSON.stringify(groups)) return { ...entry, next: entry.text };
  const hooks = { ...entry.doc.hooks };
  if (groups.length) hooks.SessionStart = groups;
  else delete hooks.SessionStart;
  const eol = entry.text?.includes('\r\n') ? '\r\n' : '\n';
  const next = JSON.stringify({ ...entry.doc, hooks }, null, 2).replaceAll('\n', eol) + eol;
  return { ...entry, next };
}

export function planCodexInstall(dir, userDir, script) {
  const hooks = readHooks(dir);
  const config = readToml(path.join(dir, 'config.toml'));
  const inherited = config.statusLine === undefined && dir !== userDir
    ? readToml(path.join(userDir, 'config.toml')).statusLine : undefined;
  const next = addThreadId(config, inherited);
  // Check the resulting TOML before writing either file.
  try { parseTOML(next); }
  catch { throw new Error(`无法将 thread-id 加入 ${config.file} 的 tui.status_line`); }
  const handler = { type: 'command', command: codexHookCommand(script), timeout: 15, statusMessage: HOOK_STATUS };
  return [{ ...config, next }, changeHooks(hooks, handler)];
}

export function planCodexUninstall(dir) {
  return changeHooks(readHooks(dir), null);
}

export function writeCodexFile({ file, dest, text, mode, next }) {
  if (next === text) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const temp = path.join(path.dirname(dest), `.hms-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, next, { mode, flag: 'wx' });
    const current = readFile(file);
    if (current.text !== text || current.dest !== dest) throw new Error(`${file} 在安装期间发生变化，请重试`);
    fs.renameSync(temp, dest);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return true;
}
