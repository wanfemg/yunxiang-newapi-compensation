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
