import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'herdr-mattpocock-skills';
const RECEIPT = '.hms-install.json';
const PAYLOAD = ['SKILL.md', 'agents', 'roles', 'references', 'templates', 'scripts'];
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

// 各宿主的技能目录（以宿主文档为准；如有变化只需改这里）。
const TARGETS = {
  agents: { label: '通用 .agents/skills（Codex、Antigravity 等）', project: '.agents/skills', global: env => path.join(home(env), '.agents/skills') },
  claude: { label: 'Claude Code', project: '.claude/skills', global: env => path.join(home(env), '.claude/skills') },
  cursor: { label: 'Cursor', project: '.cursor/skills', global: env => path.join(home(env), '.cursor/skills') },
  dsh: { label: 'DeepSeek Harness', project: '.dsh/skills', global: env => path.join(env.DSH_HOME || path.join(home(env), '.dsh'), 'skills') },
};

const home = env => env.HOME || os.homedir();
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

export function userConfigPath(env = process.env) {
  return path.join(env.XDG_CONFIG_HOME || path.join(home(env), '.config'), NAME, 'routing.json');
}
export const projectConfigPath = project => path.join(project, '.agents/herdr/routing.json');

function listFiles(base, rel = '') {
  const abs = path.join(base, rel);
  if (fs.statSync(abs).isDirectory()) return fs.readdirSync(abs).sort().flatMap(n => listFiles(base, path.join(rel, n)));
  return [rel];
}

export function targetDir(target, { project, global, env = process.env }) {
  const t = TARGETS[target];
  if (!t) throw new Error(`未知目标 ${target}；可选：${Object.keys(TARGETS).join(', ')}`);
  return path.join(global ? t.global(env) : path.join(project, t.project), NAME);
}

export function installOne(dir, { force = false } = {}) {
  const notes = [];
  const receiptFile = path.join(dir, RECEIPT);
  let previous = null;
  if (fs.existsSync(dir)) {
    if (fs.existsSync(receiptFile)) previous = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    else if (!force) throw new Error(`${dir} 已存在且不是本安装器创建的；确认后用 --force 覆盖`);
  }
  const files = PAYLOAD.filter(p => fs.existsSync(path.join(ROOT, p))).flatMap(p => listFiles(ROOT, p));
  const ts = stamp();
  for (const [rel, hash] of Object.entries(previous?.files ?? {})) {
    const abs = path.join(dir, rel);
    if (!fs.existsSync(abs)) continue;
    if (sha(abs) !== hash) {
      fs.copyFileSync(abs, `${abs}.local-${ts}`);
      notes.push(`本地修改已备份：${rel}.local-${ts}`);
    }
    if (!files.includes(rel)) fs.rmSync(abs);
  }
  const record = {};
  for (const rel of files) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), dest);
    record[rel] = sha(dest);
  }
  fs.writeFileSync(receiptFile, `${JSON.stringify({ package: NAME, version: VERSION, installedAt: new Date().toISOString(), files: record }, null, 2)}\n`);
  return { dir, from: previous?.version ?? null, to: VERSION, notes };
}

export function uninstallOne(dir, { force = false } = {}) {
  const receiptFile = path.join(dir, RECEIPT);
  if (!fs.existsSync(dir)) return { dir, removed: false, notes: ['未安装'] };
  if (!fs.existsSync(receiptFile)) throw new Error(`${dir} 不是本安装器创建的，未删除`);
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  const modified = Object.entries(receipt.files).filter(([rel, hash]) => fs.existsSync(path.join(dir, rel)) && sha(path.join(dir, rel)) !== hash).map(([rel]) => rel);
  if (modified.length && !force) throw new Error(`以下文件有本地修改，确认后用 --force 删除：${modified.join(', ')}`);
  fs.rmSync(dir, { recursive: true, force: true });
  return { dir, removed: true, notes: [] };
}

export function initConfig(file, { force = false } = {}) {
  if (fs.existsSync(file) && !force) return { file, created: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'templates/routing.json'), file);
  return { file, created: true };
}

function parse(argv) {
  const o = { _: [], targets: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} 缺少值`); return v; };
    if (a === '--target' || a === '-t') o.targets.push(...take().split(',').filter(Boolean));
    else if (a.startsWith('--target=')) o.targets.push(...a.slice(9).split(',').filter(Boolean));
    else if (a === '--project') o.project = path.resolve(take());
    else if (a === '--global' || a === '-g') o.global = true;
    else if (a === '--force') o.force = true;
    else if (a === '--no-config') o.noConfig = true;
    else if (a === '--project-config') o.projectConfig = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('-')) throw new Error(`未知参数 ${a}`);
    else o._.push(a);
  }
  if (o.global && o.project) throw new Error('--global 与 --project 不能同时使用');
  o.project ??= process.cwd();
  return o;
}

async function pickTargets(o, io) {
  if (o.targets.length) return [...new Set(o.targets)];
  if (!io.stdin.isTTY) throw new Error(`非交互环境请用 --target 指定：${Object.keys(TARGETS).join(',')}`);
  const keys = Object.keys(TARGETS);
  io.stdout.write(`选择安装目标（逗号分隔编号）：\n${keys.map((k, i) => `  ${i + 1}. ${k} — ${TARGETS[k].label}`).join('\n')}\n`);
  const rl = readline.createInterface({ input: io.stdin, output: io.stdout });
  const answer = await rl.question('> ');
  rl.close();
  const picked = answer.split(/[\s,]+/).filter(Boolean).map(v => (/^\d+$/.test(v) ? keys[Number(v) - 1] : v));
  if (!picked.length || picked.some(p => !TARGETS[p])) throw new Error('没有有效的选择');
  return [...new Set(picked)];
}

const HELP = `${NAME} ${VERSION}

  install    [--target agents,claude,cursor,dsh] [--project DIR | --global] [--force] [--no-config] [--project-config]
  uninstall  [--target ...] [--project DIR | --global] [--force]
  status     [--project DIR | --global]
  config     init [--project-config] [--project DIR] [--force]  |  config path [--project DIR]

更新 = 再次运行 install：本地修改过的技能文件会先备份为 *.local-<时间>。
用户配置存放在技能目录之外（${userConfigPath()} 或 <项目>/.agents/herdr/routing.json），安装、更新、卸载都不会改动它。`;

export async function run(argv, io = { stdin: process.stdin, stdout: process.stdout, env: process.env }) {
  const o = parse(argv);
  const cmd = o._[0];
  const say = s => io.stdout.write(`${s}\n`);
  if (!cmd || o.help) { say(HELP); return 0; }
  const scope = { project: o.project, global: o.global, env: io.env };

  if (cmd === 'install') {
    const targets = await pickTargets(o, io);
    for (const t of targets) {
      const r = installOne(targetDir(t, scope), o);
      say(`${t}: ${r.dir} ${r.from ? `${r.from} → ${r.to}` : `已安装 ${r.to}`}`);
      r.notes.forEach(n => say(`  ${n}`));
    }
    if (targets.length > 1) say('提示：部分宿主会同时扫描多个技能目录；如果出现重复的技能，只保留一个目标。');
    if (!o.noConfig) {
      const c = initConfig(o.projectConfig ? projectConfigPath(o.project) : userConfigPath(io.env));
      say(c.created ? `已生成配置：${c.file}（请按本机工具和模型修改）` : `保留现有配置：${c.file}`);
    }
    return 0;
  }
  if (cmd === 'uninstall') {
    const targets = o.targets.length ? o.targets : Object.keys(TARGETS).filter(t => fs.existsSync(path.join(targetDir(t, scope), RECEIPT)));
    if (!targets.length) { say('没有找到已安装的目标'); return 0; }
    for (const t of targets) say(`${t}: ${uninstallOne(targetDir(t, scope), o).dir} 已删除`);
    say('用户配置未改动。');
    return 0;
  }
  if (cmd === 'status') {
    for (const t of Object.keys(TARGETS)) {
      const dir = targetDir(t, scope);
      const receipt = path.join(dir, RECEIPT);
      say(`${t}: ${fs.existsSync(receipt) ? `${JSON.parse(fs.readFileSync(receipt, 'utf8')).version} @ ${dir}` : '未安装'}`);
    }
    for (const f of [projectConfigPath(o.project), userConfigPath(io.env)]) say(`配置 ${f}: ${fs.existsSync(f) ? '存在' : '无'}`);
    return 0;
  }
  if (cmd === 'config') {
    const file = o.projectConfig ? projectConfigPath(o.project) : userConfigPath(io.env);
    if (o._[1] === 'path') {
      const active = [projectConfigPath(o.project), userConfigPath(io.env)].find(f => fs.existsSync(f));
      say(active ?? '尚无用户配置，将使用随包模板');
      return 0;
    }
    if (o._[1] === 'init') {
      const c = initConfig(file, o);
      say(c.created ? `已生成配置：${c.file}` : `配置已存在：${c.file}（覆盖请加 --force）`);
      return 0;
    }
  }
  throw new Error(`未知命令 ${argv.join(' ')}；运行 --help 查看用法`);
}
