import readline from 'node:readline';
import { KeelConfig, loadConfig } from './config.js';
import { SessionStore } from './core/store.js';
import { fold } from './core/fold.js';
import { runUserTurn, getGitBranch } from './core/loop.js';
import { TerminalUi, statusLine } from './ui/render.js';
import { ansi } from './util/ansi.js';
import { forkSession, listSessions, replaySession, costReport } from './commands.js';

const BANNER = [
  '██╗  ██╗ ███████╗███████╗██╗       █████╗  ██████╗ ███████╗███╗   ██╗████████╗',
  '██║ ██╔╝ ██╔════╝██╔════╝██║      ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝',
  '█████╔╝  █████╗  █████╗  ██║      ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ',
  '██╔═██╗  ██╔══╝  ██╔══╝  ██║      ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ',
  '██║  ██╗ ███████╗███████╗███████╗ ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ',
  '╚═╝  ╚═╝ ╚══════╝╚══════╝╚══════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ',
].join('\n');

const HELP = `命令:
  /help                 本帮助
  /new                  开新会话
  /sessions             列出历史会话
  /plan                 查看当前计划（fold 自事件流）
  /replay [id]          只读回放某个会话的事件流
  /fork <id> [seq]      从事件 seq 分叉新会话（默认到最后），并切换过去
  /cost [id]            成本报告（按模型、验证状态）
  /policy               查看当前生效策略
  /exit                 退出（Ctrl+C 两次）

提示: 回合进行中输入的文本会排队，回合结束后依次执行；Ctrl+C 安全中断当前回合。`;

export interface ReplOptions {
  cwd: string;
  sessionId?: string;
}

export async function startRepl(opts: ReplOptions): Promise<void> {
  const { cfg, sources } = loadConfig(opts.cwd);
  const ui = new TerminalUi();

  let store = openOrCreate(opts.sessionId, opts.cwd, cfg);
  const projectCwd = store.meta.cwd;

  const bannerModel = process.env.KEEL_MOCK === '1' ? 'mock 模式（KEEL_MOCK=1）' : cfg.router.main;
  console.log(`\n${ansi.dim(BANNER)}`);
  console.log(`  龙骨 · 可回放、可验证的编码智能体`);
  console.log(`  模型 ${bannerModel} · 工作目录 ${projectCwd}${getGitBranch(projectCwd) ? ` · 分支 ${getGitBranch(projectCwd)}` : ''}`);
  if (sources.length) console.log(`  配置: ${sources.join(' + ')}`);
  console.log(`  /help 查看命令，直接输入描述任务即可开始\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'keel › ',
  });

  let busy = false;
  let controller: AbortController | null = null;
  const queue: string[] = [];

  const processInput = (text: string): void => {
    busy = true;
    controller = new AbortController();
    runUserTurn({ store, cfg, ui, interactive: true, userText: text, autoApprove: false, signal: controller.signal })
      .then((summary) => {
        if (summary.stopReason === 'aborted') ui.warn('回合已中断（已执行部分完整落盘，可 fork 回溯）');
        ui.status(statusLine(store.id, summary.stopReason, summary.spendUsd, cfg.router.main));
      })
      .catch((e) => ui.error(`回合异常: ${(e as Error).stack ?? e}`))
      .finally(() => {
        busy = false;
        controller = null;
        const next = queue.shift();
        if (next) processInput(next);
        else rl.prompt();
      });
  };

  rl.on('SIGINT', () => {
    if (busy) {
      if (controller && !controller.signal.aborted) {
        controller.abort();
        ui.warn('正在安全中断…（再按一次 Ctrl+C 强制退出）');
      } else {
        console.log();
        process.exit(130);
      }
    } else {
      rl.close();
    }
  });
  rl.on('close', () => {
    console.log('\n再见。会话已持久化，随时 keel --session <id> 继续。');
    process.exit(0);
  });

  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      return;
    }
    if (text === '/exit' || text === '/quit') {
      rl.close();
      return;
    }
    if (busy) {
      queue.push(text);
      ui.note(`回合进行中，已排队（前方 ${queue.length} 条）`);
      return;
    }
    if (text.startsWith('/')) {
      handleSlash(text, { store: () => store, setStore: (s) => void (store = s), cfg, ui });
      rl.prompt();
      return;
    }
    processInput(text);
  });

  rl.prompt();
}

function openOrCreate(sessionId: string | undefined, cwd: string, cfg: KeelConfig): SessionStore {
  if (sessionId) {
    const store = SessionStore.open(sessionId);
    console.log(`继续会话 ${store.id}（${store.readAll().filter((e) => e.type === 'turn.completed').length} 回合）`);
    return store;
  }
  const store = SessionStore.create({ cwd, model: cfg.router.main, interactive: true });
  store.append('session.started', {
    cwd,
    gitBranch: getGitBranch(cwd),
    model: cfg.router.main,
    interactive: true,
  });
  return store;
}

function handleSlash(
  text: string,
  ctx: { store: () => SessionStore; setStore: (s: SessionStore) => void; cfg: KeelConfig; ui: TerminalUi },
): void {
  const [cmd, ...args] = text.split(/\s+/);
  switch (cmd) {
    case '/help':
      console.log(HELP);
      break;
    case '/new': {
      const s = SessionStore.create({ cwd: ctx.store().meta.cwd, model: ctx.cfg.router.main, interactive: true });
      s.append('session.started', {
        cwd: s.meta.cwd,
        gitBranch: getGitBranch(s.meta.cwd),
        model: ctx.cfg.router.main,
        interactive: true,
      });
      ctx.setStore(s);
      ctx.ui.status(`新会话 ${s.id}`);
      break;
    }
    case '/sessions':
      listSessions(ctx.ui);
      break;
    case '/plan': {
      const st = fold(ctx.store().readAll());
      if (!st.plan?.length) {
        ctx.ui.status('当前没有计划。让模型开始多步骤任务时会自动用 plan 工具建立。');
        break;
      }
      const done = st.plan.filter((s) => s.status === 'done').length;
      const lines = st.plan.map((s) => `  ${s.status === 'done' ? '✓' : s.status === 'in_progress' ? '▸' : '·'} ${s.text}`);
      ctx.ui.status(`计划（${done}/${st.plan.length} 完成，fold 自事件流）\n${lines.join('\n')}`);
      break;
    }
    case '/replay': {
      const id = args[0] ?? ctx.store().id;
      replaySession(id, ctx.ui);
      break;
    }
    case '/fork': {
      const id = args[0];
      if (!id) {
        ctx.ui.error('用法: /fork <sessionId> [seq]');
        break;
      }
      const atRaw = args[1];
      const at = atRaw != null && Number.isFinite(Number(atRaw)) ? Number(atRaw) : null;
      const child = forkSession(id, at);
      ctx.setStore(child);
      ctx.ui.status(`已分叉到新会话 ${child.id}（基于 ${id}@${child.meta.forkedAtSeq}），后续对话从这里继续`);
      break;
    }
    case '/cost':
      costReport(args[0] ?? ctx.store().id, ctx.ui);
      break;
    case '/policy':
      ctx.ui.status(JSON.stringify(ctx.cfg.policy, null, 2));
      break;
    default:
      ctx.ui.error(`未知命令 ${cmd}，/help 查看帮助`);
  }
}
