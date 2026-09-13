import readline from 'node:readline';
import { KeelConfig, loadConfig } from './config.js';
import { SessionStore } from './core/store.js';
import { runUserTurn, getGitBranch } from './core/loop.js';
import { TerminalUi, statusLine } from './ui/render.js';
import { forkSession, listSessions, replaySession, costReport } from './commands.js';

const HELP = `命令:
  /help                 本帮助
  /new                  开新会话
  /sessions             列出历史会话
  /replay <id>          只读回放某个会话的事件流
  /fork <id> [seq]      从事件 seq 分叉新会话（默认到最后），并切换过去
  /cost [id]            成本报告（按模型、验证状态）
  /policy               查看当前生效策略
  /exit                 退出（Ctrl+C 两次）`;

export interface ReplOptions {
  cwd: string;
  sessionId?: string;
}

export async function startRepl(opts: ReplOptions): Promise<void> {
  const { cfg, sources } = loadConfig(opts.cwd);
  const ui = new TerminalUi();

  const bannerModel = process.env.KEEL_MOCK === '1' ? 'mock 模式（KEEL_MOCK=1）' : cfg.router.main;
  console.log(`\n  keel 龙骨 · 可回放、可验证的编码智能体`);
  console.log(`  模型 ${bannerModel} · 工作目录 ${opts.cwd}${getGitBranch(opts.cwd) ? ` · 分支 ${getGitBranch(opts.cwd)}` : ''}`);
  if (sources.length) console.log(`  配置: ${sources.join(' + ')}`);
  console.log(`  /help 查看命令，直接输入描述任务即可开始\n`);

  let store = openOrCreate(opts.sessionId, opts.cwd, cfg, true);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'keel › ',
  });

  let busy = false;
  let aborted = false;

  rl.on('SIGINT', () => {
    if (busy) {
      aborted = true;
      ui.warn('收到中断，正在安全收尾当前回合…');
    } else {
      rl.close();
    }
  });
  rl.on('close', () => {
    console.log(ansiDim('\n再见。会话已持久化，随时 keel --session <id> 继续。'));
    process.exit(0);
  });

  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      return;
    }
    if (busy) {
      ui.warn('当前回合还在进行中');
      return;
    }
    if (text.startsWith('/')) {
      handleSlash(text, { store: () => store, setStore: (s) => (store = s), cfg, ui });
      rl.prompt();
      return;
    }
    busy = true;
    runUserTurn({ store, cfg, ui, interactive: true, userText: text, autoApprove: false, isAborted: () => aborted })
      .then((summary) => {
        ui.status(statusLine(store.id, summary.stopReason, summary.spendUsd, cfg.router.main));
      })
      .catch((e) => ui.error(`回合异常: ${(e as Error).stack ?? e}`))
      .finally(() => {
        busy = false;
        aborted = false;
        rl.prompt();
      });
  });

  rl.prompt();
}

function ansiDim(s: string): string {
  return process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s;
}

function openOrCreate(sessionId: string | undefined, cwd: string, cfg: KeelConfig, interactive: boolean): SessionStore {
  if (sessionId) {
    const store = SessionStore.open(sessionId);
    console.log(`继续会话 ${store.id}（${fold_turns(store)} 回合）`);
    return store;
  }
  const store = SessionStore.create({ cwd, model: cfg.router.main, interactive });
  store.append('session.started', {
    cwd,
    gitBranch: getGitBranch(cwd),
    model: cfg.router.main,
    interactive,
  });
  return store;
}

function fold_turns(store: SessionStore): number {
  // 避免在 repl 顶部引入完整 fold 的循环依赖成本，这里用事件计数近似
  return store.readAll().filter((e) => e.type === 'turn.completed').length;
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
      const seq = args[1] ? Number(args[1]) : null;
      const child = forkSession(id, Number.isFinite(seq) ? seq : null);
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
