import fs from 'node:fs';
import path from 'node:path';
import { keelHome } from './core/store.js';

export interface ProviderCfg {
  baseURL: string;
  apiKeyEnv: string;
}

export interface PolicyCfg {
  denyPaths: string[];
  bashDeny: string[];
  bashApprove: string[];
  readOnly: boolean;
}

export interface KeelConfig {
  providers: Record<string, ProviderCfg>;
  /** "provider/model"，main 干活、fast 做摘要/标题等辅助 */
  router: { main: string; fast: string };
  budget: { maxUsdPerSession: number };
  policy: PolicyCfg;
  /** 完成契约的默认验证命令 */
  verify: { commands: string[] };
  context: { compactThresholdTokens: number; keepRecentMessages: number };
  maxTurns: number;
}

export const DEFAULT_PROVIDERS: Record<string, ProviderCfg> = {
  deepseek: { baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  zhipu: { baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKeyEnv: 'ZHIPU_API_KEY' },
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
    },
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

/** 全局 ~/.keel/config.json 与项目 .keel.json 合并，项目优先 */
export function loadConfig(cwd: string = process.cwd()): LoadedConfig {
  const defaults = defaultConfig();
  const sources: string[] = [];
  let cfg = defaults;

  const globalFile = path.join(keelHome(), 'config.json');
  if (fs.existsSync(globalFile)) {
    try {
      cfg = deepMerge(cfg, JSON.parse(fs.readFileSync(globalFile, 'utf8')));
      sources.push(globalFile);
    } catch (e) {
      throw new Error(`解析 ${globalFile} 失败: ${(e as Error).message}`);
    }
  }
  const projectFile = path.join(cwd, '.keel.json');
  if (fs.existsSync(projectFile)) {
    try {
      cfg = deepMerge(cfg, JSON.parse(fs.readFileSync(projectFile, 'utf8')));
      sources.push(projectFile);
    } catch (e) {
      throw new Error(`解析 ${projectFile} 失败: ${(e as Error).message}`);
    }
  }
  return { cfg, sources };
}

export function configTemplate(): string {
  const d = defaultConfig();
  return JSON.stringify(
    {
      ...d,
      router: { main: 'deepseek/deepseek-chat', fast: 'deepseek/deepseek-chat' },
      verify: { commands: ['npm test'] },
      _说明: {
        providers: '内置 deepseek/zhipu/moonshot/qwen/openai；apiKeyEnv 指定从哪个环境变量读密钥',
        router: '格式 provider/model；main 干活，fast 做上下文压缩等便宜活',
        verify: '完成契约的默认验证命令，agent 修改文件后必须跑通才能声明完成',
        policy: 'denyPaths 拦路径（读和写都拦）；bashDeny 直接拒绝；bashApprove 需要人工确认',
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
