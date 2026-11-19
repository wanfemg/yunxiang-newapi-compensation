import test from 'node:test';
import assert from 'node:assert/strict';
import {renderQueryBatch} from '../public/query-batches.js';
import {limitMessage} from '../public/limit-status.js';

const limit={code:'USER_DAILY_QUOTA_LIMIT',kind:'quota',scope:'user',used:200,limit:300,remaining:100,required:150,nextResetAt:Date.UTC(2026,10,20,16),timezone:'Asia/Shanghai',message:'原始额度已用200，上限300，本次150'};
const money=value=>'额度 '+(value/100).toFixed(2);
const batch={id:'fixture',status:'waiting_limit',note:limit.message,limit,previousLimit:limit,end:1795176000,paidAmount:0,expectedAmount:150,records:1,models:['fixture-model'],items:[{requestId:'r1',model:'fixture-model',status:'approved',amount:150}]};

test('限额提示沿用站点显示单位，金额与原因仅显示一次并显示站点恢复时间',()=>{
  const html=renderQueryBatch(batch,{money});
  assert.match(html,/额度 2\.00 \/ 额度 3\.00/);
  assert.match(html,/剩余 额度 1\.00/);
  assert.match(html,/本次需要 额度 1\.50/);
  assert.match(html,/2026\/11\/21 00:00:00/);
  assert.equal((html.match(/class="notice warning batch-limit"/g)||[]).length,1);
  assert.ok(!html.includes(limit.message));
  assert.match(html,/data-resume-batch="fixture"/);
});

test('限额恢复后显示可继续补偿，单次硬上限不误报明天恢复',()=>{
  const html=renderQueryBatch({...batch,limit:null});
  assert.match(html,/审核通过 · 可继续补偿/);
  assert.ok(!html.includes(limit.message));
  const permanent=limitMessage({...limit,code:'PER_BATCH_QUOTA_LIMIT',nextResetAt:null},{money});
  assert.match(permanent,/单次补偿上限/);
  assert.match(permanent,/管理员调整/);
  assert.ok(!permanent.includes('下次恢复'));
});
