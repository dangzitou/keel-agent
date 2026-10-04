import fs from 'node:fs';
import path from 'node:path';
import { keelHome } from './core/store.js';

export type ProviderApi = 'openai' | 'anthropic' | 'responses';

export interface ProviderCfg {
  baseURL: string;
  apiKeyEnv: string;
  /** 线协议：openai=chat/completions（默认）、anthropic=messages、responses=OpenAI Responses */
  api?: ProviderApi;
}

export interface PolicyCfg {
  denyPaths: string[];
  bashDeny: string[];
  bashApprove: string[];
  readOnly: boolean;
  /** 禁止读写工作目录之外的路径（默认开启；bash 不受此约束，见 README 安全边界） */
  constrainToWorkspace: boolean;
}

export interface LlmCfg {
  /** 瞬态错误（429/5xx/网络）的最大重试次数 */
  retries: number;
  /** 单次请求超时毫秒 */
  timeoutMs: number;
  /** SSE 流式输出（部分兼容网关不支持时可关） */
  stream: boolean;
}

export interface KeelConfig {
  providers: Record<string, ProviderCfg>;
  /** "provider/model"，main 干活、fast 做摘要/标题等辅助 */
  router: { main: string; fast: string };
  budget: { maxUsdPerSession: number };
  policy: PolicyCfg;
  llm: LlmCfg;
  /** 完成契约的默认验证命令 */
  verify: { commands: string[] };
  context: { compactThresholdTokens: number; keepRecentMessages: number };
  maxTurns: number;
}

export const DEFAULT_PROVIDERS: Record<string, ProviderCfg> = {
  deepseek: { baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  zhipu: { baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKeyEnv: 'ZHIPU_API_KEY' },
  'glm-anthropic': { baseURL: 'https://open.bigmodel.cn/api/anthropic', apiKeyEnv: 'ZHIPU_API_KEY', api: 'anthropic' },
  stepfun: { baseURL: 'https://api.stepfun.com/step_plan/v1', apiKeyEnv: 'STEPFUN_API_KEY', api: 'responses' },
  moonshot: { baseURL: 'https://api.moonshot.cn/v1', apiKeyEnv: 'MOONSHOT_API_KEY' },
  qwen: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKeyEnv: 'DASHSCOPE_API_KEY' },
  openai: { baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
};

export function defaultConfig(): KeelConfig {
  return {
    providers: { ...DEFAULT_PROVIDERS },
    router: { main: 'deepseek/deepseek-chat', fast: 'deepseek/deepseek-chat' },
    budget: { maxUsdPerSession: 5 },
    policy: {
      denyPaths: ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '.git/**', '.keel/**'],
      bashDeny: ['rm -rf /', 'rm -rf /*', 'sudo *', 'shutdown*', 'mkfs*', 'dd if=*'],
      bashApprove: ['git push*', 'rm *', 'npm publish*', 'mv * /', 'chmod -R *'],
      readOnly: false,
      constrainToWorkspace: true,
    },
    llm: { retries: 3, timeoutMs: 600_000, stream: true },
    verify: { commands: [] },
    context: { compactThresholdTokens: 48000, keepRecentMessages: 6 },
    maxTurns: 40,
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) return (override as T) ?? base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export interface LoadedConfig {
  cfg: KeelConfig;
  sources: string[];
}

/** 全局 ~/.keel/config.json 与项目 .keel.json 合并，项目优先；最后应用环境变量直配（最轻量的接入方式） */
export function loadConfig(cwd: string = process.cwd()): LoadedConfig {
  const defaults = defaultConfig();
  const sources: string[] = [];
  let cfg = defaults;

  const globalFile = path.join(keelHome(), 'config.json');
  if (fs.existsSync(globalFile)) {
    try {
      cfg = deepMerge(cfg, JSON.parse(fs.readFileSync(globalFile, 'utf-8')));
      sources.push(globalFile);
    } catch (e) {
      throw new Error(`解析 ${globalFile} 失败: ${(e as Error).message}`);
    }
  }
  const projectFile = path.join(cwd, '.keel.json');
  if (fs.existsSync(projectFile)) {
    try {
      cfg = deepMerge(cfg, JSON.parse(fs.readFileSync(projectFile, 'utf-8')));
      sources.push(projectFile);
    } catch (e) {
      throw new Error(`解析 ${projectFile} 失败: ${(e as Error).message}`);
    }
  }
  const envApplied = applyEnvOverrides(cfg);
  if (envApplied) sources.push('env:KEEL_MODEL');
  return { cfg, sources };
}

/** 各内置 provider 的代表模型：自动选择默认模型时用（同一 env key 只取最靠前的 openai 兼容项） */
const AUTO_MODEL: Array<[provider: string, model: string]> = [
  ['zhipu', 'zhipu/glm-4.6'],
  ['glm-anthropic', 'glm-anthropic/glm-5.3'],
  ['stepfun', 'stepfun/step-5-preview'],
  ['moonshot', 'moonshot/kimi-k2-0711-preview'],
  ['qwen', 'qwen/qwen-plus'],
  ['openai', 'openai/gpt-4o-mini'],
];

/**
 * 易用性默认值：仅当 router 仍是出厂默认（deepseek/deepseek-chat）且其 key 不在时，
 * 自动切到环境里有 key 的内置 provider（多个在场时按上表优先级取第一个）——
 * "export 一个 key 即用"。任何显式配置（.keel.json / config.json / KEEL_MODEL）都优先于它。
 */
export function autoModelFromEnv(providers: Record<string, ProviderCfg>, defaultMain: string): string | null {
  if (defaultMain !== 'deepseek/deepseek-chat') return null; // 用户已显式选择，不越权
  if (process.env.DEEPSEEK_API_KEY) return null;
  for (const [name, model] of AUTO_MODEL) {
    const pcfg = providers[name];
    if (pcfg && process.env[pcfg.apiKeyEnv]) return model;
  }
  return null;
}

/**
 * 环境变量直配（优先级最高，零配置文件）：
 *   KEEL_MODEL=stepfun/step-5-preview          内置 provider 直接引用
 *   KEEL_MODEL=my-model KEEL_BASE_URL=... KEEL_API_KEY=... KEEL_API=anthropic|responses|openai
 *   KEEL_FAST_MODEL=...                         可选，压缩等辅助调用
 */
function applyEnvOverrides(cfg: KeelConfig): boolean {
  const resolve = (ref: string): string | null => {
    const v = process.env[ref]?.trim();
    if (!v) return null;
    const slash = v.indexOf('/');
    const providerName = slash > 0 ? v.slice(0, slash) : '';
    if (providerName && cfg.providers[providerName]) return v; // 内置/已配置 provider
    // Keep an explicit provider prefix intact so Router can reject a typo instead of using the generic endpoint.
    if (providerName && providerName !== 'env') return v;
    const baseURL = process.env.KEEL_BASE_URL?.trim();
    const apiKey = process.env.KEEL_API_KEY?.trim();
    if (!baseURL && !apiKey) return v;
    // Bare model names and explicit env/model may use the generic endpoint when configured.
    if (!cfg.providers.env) {
      const api = (['openai', 'anthropic', 'responses'] as const).includes(process.env.KEEL_API as 'openai')
        ? (process.env.KEEL_API as ProviderApi)
        : 'openai';
      cfg.providers.env = {
        baseURL: baseURL || 'https://api.openai.com/v1',
        apiKeyEnv: 'KEEL_API_KEY',
        api,
      };
    }
    return `env/${slash > 0 ? v.slice(slash + 1) : v}`;
  };
  const main = resolve('KEEL_MODEL');
  if (main) cfg.router.main = main;
  const fast = resolve('KEEL_FAST_MODEL');
  if (fast) cfg.router.fast = fast;
  else if (main) cfg.router.fast = main;
  if (!main && !fast) {
    const auto = autoModelFromEnv(cfg.providers, cfg.router.main);
    if (auto) {
      cfg.router.main = auto;
      cfg.router.fast = auto;
    }
    return Boolean(auto);
  }
  return true;
}

export function configTemplate(): string {
  const d = defaultConfig();
  return JSON.stringify(
    {
      ...d,
      router: { main: 'deepseek/deepseek-chat', fast: 'deepseek/deepseek-chat' },
      verify: { commands: ['npm test'] },
      _说明: {
        providers: '内置 deepseek/zhipu/glm-anthropic/stepfun/moonshot/qwen/openai；api 指定线协议(openai|anthropic|responses)；apiKeyEnv 指定从哪个环境变量读密钥',
        router: '格式 provider/model；main 干活，fast 做上下文压缩等便宜活；也可用环境变量 KEEL_MODEL/KEEL_BASE_URL/KEEL_API_KEY/KEEL_API 直配（优先级最高）',
        llm: 'retries=瞬态错误重试次数；timeoutMs=单请求超时；stream=流式输出',
        verify: '完成契约的默认验证命令，agent 修改文件后必须跑通才能声明完成',
        policy: 'denyPaths 拦路径（读和写都拦）；constrainToWorkspace 禁止出工作目录；bashDeny 直接拒绝；bashApprove 需人工确认',
      },
    },
    null,
    2,
  );
}

export function initConfig(): string {
  const file = path.join(keelHome(), 'config.json');
  if (fs.existsSync(file)) return `已存在: ${file}`;
  fs.mkdirSync(keelHome(), { recursive: true });
  fs.writeFileSync(file, configTemplate(), 'utf8');
  return file;
}
