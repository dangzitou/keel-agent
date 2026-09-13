import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, globMatch } from '../src/util/glob.js';

test('glob: 基础通配', () => {
  assert.ok(globMatch('*.ts', 'a.ts'));
  assert.ok(globMatch('*.ts', 'src/a.ts')); // 无斜杠模式匹配任意层级（.gitignore 语义）
  assert.ok(!globMatch('src/*.ts', 'src/a/b.ts')); // 单 * 不跨目录
  assert.ok(globMatch('src/*.ts', 'src/a.ts'));
  assert.ok(globMatch('src/**/*.ts', 'src/a/b/c.ts'));
  assert.ok(globMatch('src/**/*.ts', 'src/a.ts')); // ** 可匹配零层
  assert.ok(globMatch('?.txt', 'a.txt'));
  assert.ok(!globMatch('?.txt', 'ab.txt'));
});

test('glob: 无斜杠模式匹配任意层级的 basename（.gitignore 语义）', () => {
  assert.ok(globMatch('*.pem', 'certs/server.pem'));
  assert.ok(globMatch('.env', 'config/.env'));
  assert.ok(globMatch('.env', '.env'));
});

test('glob: 正则元字符转义', () => {
  const re = globToRegExp('a+b.txt');
  assert.ok(re.test('a+b.txt'));
  assert.ok(!re.test('aab.txt'));
});
