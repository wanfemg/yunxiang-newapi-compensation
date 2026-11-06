import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

test('Linux shell entrypoints use LF without BOM', () => {
  const root = join(import.meta.dirname, '..');
  for (const dir of [root, join(root, 'test')]) {
    for (const name of readdirSync(dir).filter(name => name.endsWith('.sh'))) {
      const text = readFileSync(join(dir, name), 'utf8');
      assert.ok(text.startsWith('#!/usr/bin/env bash\n'), name + ' requires an LF shebang');
      assert.ok(!text.includes('\r'), name + ' must not contain CRLF');
    }
  }
});

test('Docker test stage includes shell fixtures in build context and COPY', () => {
  const root = join(import.meta.dirname, '..');
  const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
  const ignore = readFileSync(join(root, '.dockerignore'), 'utf8');
  assert.match(ignore, /^!\*\.sh\s*$/m, 'root shell scripts must reach the build context');
  assert.match(dockerfile, /COPY \*\.sh \.\/[\s\S]*?RUN node --test/, 'copy deployment scripts before testing');
});

test('SMTP 依赖锁随一键安装校验、路径检查、源码复制与 Docker 构建分发', () => {
  const root=join(import.meta.dirname,'..'),installer=readFileSync(join(root,'install.sh'),'utf8');
  const lists=installer.split('\n').filter(line=>line.startsWith('for item in '));
  assert.equal(lists.length,3);for(const line of lists)assert.ok(line.includes('package-lock.json'));
  assert.match(readFileSync(join(root,'.dockerignore'),'utf8'),/^!package-lock[.]json$/m);
  const dockerfile=readFileSync(join(root,'Dockerfile'),'utf8');assert.match(dockerfile,/npm ci --omit=dev/);assert.match(dockerfile,/COPY --from=test[^\n]+node_modules/);
  const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8')),lock=JSON.parse(readFileSync(join(root,'package-lock.json'),'utf8'));
  assert.equal(lock.packages['node_modules/nodemailer'].version,pkg.dependencies.nodemailer);
});
