import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { projectConfigPath, projectRoot, readRouting } from '../skills/herdr-mattpocock-skills/scripts/routing.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'herdr-mattpocock-skills';
const RECEIPT = '.hms-install.json';
const SKILLS = {
  [NAME]: { root: path.join(ROOT, 'skills', NAME), files: ['SKILL.md', 'AGENTS.md', 'agents', 'roles', 'templates', 'scripts'] },
  'herdr-setup': { root: path.join(ROOT, 'skills', 'herdr-setup'), files: ['SKILL.md', 'agents', 'templates', 'references', 'scripts'] },
};
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

function listFiles(base, rel = '') {
  const abs = path.join(base, rel);
  if (fs.statSync(abs).isDirectory()) return fs.readdirSync(abs).sort().flatMap(n => listFiles(base, path.join(rel, n)));
  return [rel];
}

export function targetDir(target, { project, global, env = process.env }, name = NAME) {
  const t = TARGETS[target];
  if (!t) throw new Error(`未知目标 ${target}；可选：${Object.keys(TARGETS).join(', ')}`);
  return path.join(global ? t.global(env) : path.join(project, t.project), name);
}

function actualPath(dir) {
  if (fs.existsSync(dir)) return fs.realpathSync(dir);
  return path.join(actualPath(path.dirname(dir)), path.basename(dir));
}

export function installOne(dir, { force = false } = {}, name = NAME) {
  const notes = [];
  const receiptFile = path.join(dir, RECEIPT);
  let previous = null;
  if (fs.existsSync(dir)) {
    if (fs.existsSync(receiptFile)) previous = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    else if (!force) throw new Error(`${dir} 已存在且不是本安装器创建的；确认后用 --force 覆盖`);
    else {
      const backups = path.resolve(dir, '../../.hms-backups');
      fs.mkdirSync(backups, { recursive: true });
      const backup = path.join(backups, `${name}-${stamp()}-${crypto.randomUUID().slice(0, 8)}`);
      fs.renameSync(dir, backup);
      notes.push(`旧目录已完整保留在 ${backup}`);
    }
  }
  const skill = SKILLS[name];
  const files = skill.files.flatMap(p => listFiles(skill.root, p));
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
    if (previous && !Object.hasOwn(previous.files, rel) && fs.existsSync(dest) && sha(dest) !== sha(path.join(skill.root, rel))) {
      fs.copyFileSync(dest, `${dest}.local-${ts}`);
      notes.push(`本地文件已备份：${rel}.local-${ts}`);
    }
    fs.copyFileSync(path.join(skill.root, rel), dest);
    record[rel] = sha(dest);
  }
  fs.writeFileSync(receiptFile, `${JSON.stringify({ package: NAME, skill: name, version: VERSION, installedAt: new Date().toISOString(), files: record }, null, 2)}\n`);
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
  fs.copyFileSync(path.join(SKILLS['herdr-setup'].root, 'templates/routing.json'), file, force ? 0 : fs.constants.COPYFILE_EXCL);
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
    else if (a === '--no-config' || a === '--project-config') continue; // 兼容旧安装命令
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('-')) throw new Error(`未知参数 ${a}`);
    else o._.push(a);
  }
  if (o.global && o.project) throw new Error('--global 与 --project 不能同时使用');
  o.project ??= projectRoot();
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

  install    [--target agents,claude,cursor,dsh] [--project DIR | --global] [--force]
  uninstall  [--target ...] [--project DIR | --global] [--force]
  status     [--project DIR | --global]
  config     init [--project DIR] [--force]  |  config path [--project DIR]

更新 = 再次运行 install：本地修改过的技能文件会先备份为 *.local-<时间>。
安装 HMS 和 herdr-setup。首次使用由 herdr-setup 填表并激活项目 .agents/herdr/routing.json。`;

export async function run(argv, io = { stdin: process.stdin, stdout: process.stdout, env: process.env }) {
  const o = parse(argv);
  const cmd = o._[0];
  const say = s => io.stdout.write(`${s}\n`);
  if (!cmd || o.help) { say(HELP); return 0; }
  const scope = { project: o.project, global: o.global, env: io.env };
  const names = Object.keys(SKILLS);
  const seen = new Set();
  const destinations = targets => targets.flatMap(t => names.flatMap(name => {
    const dir = actualPath(targetDir(t, scope, name));
    if (seen.has(dir)) return [];
    seen.add(dir);
    return [{ t, name, dir }];
  }));

  if (cmd === 'install') {
    const targets = await pickTargets(o, io);
    for (const { t, name, dir } of destinations(targets)) {
      const r = installOne(dir, o, name);
      say(`${t}: ${r.dir} ${r.from ? `${r.from} → ${r.to}` : `已安装 ${r.to}`}`);
      r.notes.forEach(n => say(`  ${n}`));
    }
    say('项目首次使用 HMS 时由 $herdr-setup 填表。');
    return 0;
  }
  if (cmd === 'uninstall') {
    const targets = o.targets.length ? o.targets : Object.keys(TARGETS).filter(t => names.some(name => fs.existsSync(path.join(targetDir(t, scope, name), RECEIPT))));
    if (!targets.length) { say('没有找到已安装的目标'); return 0; }
    let shared = false;
    for (const { t, name, dir } of destinations(targets)) {
      const owner = Object.keys(TARGETS).find(key => targetDir(key, scope, name) === dir);
      if (o.targets.length && owner && !targets.includes(owner)) {
        say(`${t} 与 ${owner} 共用 ${dir}。要卸载该共享副本，请选择 --target ${owner}`);
        shared = true;
        continue;
      }
      const r = uninstallOne(dir, o);
      if (r.removed) say(`${t}: ${r.dir} 已删除`);
    }
    say('用户配置未改动。');
    return shared ? 2 : 0;
  }
  if (cmd === 'status') {
    for (const t of Object.keys(TARGETS)) for (const name of names) {
      const dir = targetDir(t, scope, name);
      const receipt = path.join(dir, RECEIPT);
      say(`${t}/${name}: ${fs.existsSync(receipt) ? `${JSON.parse(fs.readFileSync(receipt, 'utf8')).version} @ ${dir}` : '未安装'}`);
    }
    const state = readRouting(projectConfigPath(o.project));
    say(`项目配置 ${state.file}：${state.active ? '已激活' : '待 $herdr-setup'}`);
    return 0;
  }
  if (cmd === 'config') {
    const file = projectConfigPath(o.project);
    if (o._[1] === 'path') {
      say(readRouting(file).active ? file : `项目尚未激活，请用 $herdr-setup 填表：${file}`);
      return 0;
    }
    if (o._[1] === 'init') {
      const c = initConfig(file, o);
      say(c.created ? `已生成未激活草稿：${c.file}。用 $herdr-setup 填表。` : `保留已有配置：${c.file}`);
      return 0;
    }
  }
  throw new Error(`未知命令 ${argv.join(' ')}；运行 --help 查看用法`);
}
