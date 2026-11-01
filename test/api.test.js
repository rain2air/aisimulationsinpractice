import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';

const server = createApp({ dataFile: null, adminPassword: 'pw' });
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

// 쿠키를 유지하는 간단한 클라이언트
const client = () => {
  const jar = {};
  return async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const [k, v] = kv.split('='); jar[k] = v; }
    return { status: res.status, data: await res.json() };
  };
};

test('관리자 등록 → 1인 1표 → 취소 → 재투표', async () => {
  const admin = client(), a = client(), b = client();
  assert.equal((await admin('POST', '/api/admin/polls', { title: 't' })).status, 401);
  assert.equal((await admin('POST', '/api/admin/login', { password: 'bad' })).status, 401);
  assert.equal((await admin('POST', '/api/admin/login', { password: 'pw' })).status, 200);
  const poll = (await admin('POST', '/api/admin/polls', { title: '회장 선거' })).data;
  const c1 = (await admin('POST', `/api/admin/polls/${poll.id}/candidates`, { name: '김' })).data.candidates[0];
  const c2 = (await admin('POST', `/api/admin/polls/${poll.id}/candidates`, { name: '이' })).data.candidates[1];

  assert.equal((await a('POST', `/api/polls/${poll.id}/vote`, { candidateId: c1.id })).status, 200);
  assert.equal((await a('POST', `/api/polls/${poll.id}/vote`, { candidateId: c2.id })).status, 409); // 중복 투표 차단
  assert.equal((await b('POST', `/api/polls/${poll.id}/vote`, { candidateId: c1.id })).status, 200);
  let list = (await a('GET', '/api/polls')).data[0];
  assert.equal(list.total, 2); assert.equal(list.myVote, c1.id);

  assert.equal((await a('DELETE', `/api/polls/${poll.id}/vote`)).status, 200); // 취소
  assert.equal((await a('DELETE', `/api/polls/${poll.id}/vote`)).status, 404);
  assert.equal((await a('POST', `/api/polls/${poll.id}/vote`, { candidateId: c2.id })).data.myVote, c2.id);

  await admin('PATCH', `/api/admin/polls/${poll.id}`, { open: false });
  assert.equal((await a('DELETE', `/api/polls/${poll.id}/vote`)).status, 409); // 마감 후 취소 불가
  assert.equal((await client()('POST', `/api/admin/polls/${poll.id}/candidates`, { name: 'x' })).status, 401);
});
