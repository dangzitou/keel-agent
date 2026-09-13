#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, initConfig } from './config.js';
import { runUserTurn, getGitBranch } from './core/loop.js';
import { SessionStore } from './core/store.js';
import { TerminalUi, statusLine } from './ui/render.js';
import { listSessions, replaySession, forkSession, costReport, doctor } from './commands.js';
import { startRepl } from './repl.js';

const USAGE = `keel（龙骨）— 可回放、可验证、可审计的编码智能体 CLI

用法:
  keel                          交互式会话（--session <id> 继续指定会话）
  keel run "<任务描述>"          单任务模式：完成后退出（--yes 自动放行敏感操作审批）
  keel sessions                 列出所有会话（含花费与验证状态）
  keel replay <id>              只读回放一个会话的完整事件流
  keel fork <id> [--at <seq>]   从第 seq 个事件分叉出新会话（默认到最后）
  keel cost <id>                会话成本报告（按模型/回合/验证状态）
  keel doctor                   环境体检：配置/密钥/价目/验证命令
  keel init                     生成 ~/.keel/config.json 配置模板

常用选项:
  --cwd <dir>     项目目录（默认当前目录）
  --session <id>  继续已有会话
  --at <seq>      fork 的事件断点
  -v, --version   版本

退出码（keel run）: 0=done 1=失败/预算/超轮次 2=参数错误 3=存在未验证修改 130=被中断

快速开始:
  1. keel init && keel doctor
  2. export DEEPSEEK_API_KEY=...   （或 ZHIPU_API_KEY / OPENAI_API_KEY 等）
  3. 项目里放一个 .keel.json 配置 verify.commands，如 ["npm test"]
  4. keel run "修复 xxx 并确保测试通过"

无 API key 也可体验：KEEL_MOCK=1 keel run "写个 hello"`;

function version(): string {
  try {
    const pkgUrl = new URL('../package.json', import.meta.url);
    return (JSON.parse(fs.readFileSync(fileURLToPath(pkgUrl), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

interface Flags {
  cwd: string;
  session?: string;
  at?: number;
  yes: boolean;
}

function parseArgs(argv: string[]): { flags: Flags; positional: string[] } {
  const flags: Flags = { cwd: process.cwd(), yes: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--cwd') flags.cwd = path.resolve(argv[++i] ?? '.');
    else if (a === '--session') flags.session = argv[++i];
    else if (a === '--at') flags.at = Number(argv[++i]);
    else if (a === '--yes') flags.yes = true;
    else positional.push(a);
  }
  return { flags, positional };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('-v') || argv.includes('--version')) {
    console.log(version());
    return;
  }
  const { flags, positional } = parseArgs(argv);
  const cmd = positional.shift() ?? 'chat';
  const ui = new TerminalUi();

  try {
    switch (cmd) {
      case 'chat':
      case 'repl': {
        await startRepl({ cwd: flags.cwd, sessionId: flags.session });
        break;
      }
      case 'run': {
        const task = positional.join(' ').trim();
        if (!task) {
          console.error('用法: keel run "任务描述"');
          process.exitCode = 2;
          return;
        }
        const { cfg } = loadConfig(flags.cwd);
        const store = SessionStore.create({ cwd: flags.cwd, model: cfg.router.main, interactive: false });
        store.append('session.started', {
          cwd: flags.cwd,
          gitBranch: getGitBranch(flags.cwd),
          model: cfg.router.main,
          interactive: false,
        });
        console.log(`会话 ${store.id} · 任务: ${task}`);

        // SIGINT → 中断信号传导到 fetch/bash，turn.completed(aborted) 落盘后以 130 退出
        const controller = new AbortController();
        const onSigint = () => {
          if (!controller.signal.aborted) {
            controller.abort();
            ui.warn('收到中断，正在安全收尾…');
          } else {
            process.exit(130);
          }
        };
        process.once('SIGINT', onSigint);

        const summary = await runUserTurn({
          store,
          cfg,
          ui,
          interactive: false,
          userText: task,
          autoApprove: flags.yes,
          signal: controller.signal,
        });
        process.removeListener('SIGINT', onSigint);
        ui.status(statusLine(store.id, summary.stopReason, summary.spendUsd, cfg.router.main));
        if (summary.stopReason === 'aborted') {
          process.exitCode = 130;
        } else if (summary.stopReason === 'unverified') {
          ui.warn('注意：任务结束但存在未通过验证的文件修改（evidenceOk=false）');
          process.exitCode = 3;
        } else if (summary.stopReason !== 'done') {
          process.exitCode = 1;
        }
        break;
      }
      case 'sessions':
        listSessions(ui);
        break;
      case 'replay':
        replaySession(requireArg(positional.shift(), 'replay <sessionId>'), ui);
        break;
      case 'fork': {
        const id = requireArg(positional.shift(), 'fork <sessionId> [--at seq]');
        const at = flags.at != null && !Number.isNaN(flags.at) ? flags.at : null;
        const child = forkSession(id, at);
        console.log(`已分叉: ${child.id}（基于 ${id}@${child.meta.forkedAtSeq}，共 ${child.seq} 个历史事件）`);
        console.log(`继续它: keel --session ${child.id}`);
        break;
      }
      case 'cost':
        costReport(requireArg(positional.shift(), 'cost <sessionId>'), ui);
        break;
      case 'doctor': {
        const { checks, ok } = doctor();
        for (const c of checks) {
          const mark = c.level === 'ok' ? '✓' : c.level === 'warn' ? '!' : '✗';
          console.log(`${mark} ${c.name}: ${c.detail}`);
        }
        if (!ok) {
          console.log('\n存在问题（✗），请先修复再使用。');
          process.exitCode = 1;
        }
        break;
      }
      case 'init': {
        const file = initConfig();
        console.log(`配置已生成: ${file}`);
        console.log('下一步: 设置对应 provider 的环境变量（如 DEEPSEEK_API_KEY），跑 keel doctor 检查，并在项目里放 .keel.json 配置 verify.commands。');
        break;
      }
      case 'help':
      case '--help':
      case '-h':
        console.log(USAGE);
        break;
      default:
        console.error(`未知命令 "${cmd}"\n\n${USAGE}`);
        process.exitCode = 2;
    }
  } catch (e) {
    ui.error((e as Error).message);
    process.exitCode = 1;
  }
}

function requireArg(v: string | undefined, usage: string): string {
  if (!v) {
    console.error(`缺少参数。用法: keel ${usage}`);
    process.exit(2);
  }
  return v;
}

main();
