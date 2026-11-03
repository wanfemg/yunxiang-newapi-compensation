import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managementToken } from '../src/config.mjs';

test('Docker secret 优先于环境令牌且不接受空值或不可读文件', () => {
  const dir=mkdtempSync(join(tmpdir(),'comp-config-')),path=join(dir,'token');
  try {
    assert.equal(managementToken({NEWAPI_ADMIN_TOKEN:'fixture-env'}),'fixture-env');
    assert.equal(managementToken({}), '');
    assert.throws(()=>managementToken({NEWAPI_ADMIN_TOKEN_FILE:path}),/不可读取/);
    writeFileSync(path,'fixture-secret\n');
    assert.equal(managementToken({NEWAPI_ADMIN_TOKEN_FILE:path,NEWAPI_ADMIN_TOKEN:'ignored'}),'fixture-secret');
    writeFileSync(path,'  ');assert.throws(()=>managementToken({NEWAPI_ADMIN_TOKEN_FILE:path}),/为空/);
    writeFileSync(path,'two tokens');assert.throws(()=>managementToken({NEWAPI_ADMIN_TOKEN_FILE:path}),/格式无效/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
