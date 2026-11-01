import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';

const server = createApp({ dataFile: null });
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

test('기본 비밀번호 root, 변경, 이전 비밀번호 무효', async () => {
  const a = client();
  assert.equal((await a('POST', '/api/admin/login', { password: 'wrong' })).status, 401);
  assert.equal((await a('POST', '/api/admin/login', { password: 'root' })).status, 200);
  assert.equal((await a('GET', '/api/admin/me')).data.defaultPassword, true);
  assert.equal((await a('POST', '/api/admin/password', { current: 'x', next: 'newpass' })).status, 401);
  assert.equal((await a('POST', '/api/admin/password', { current: 'root', next: 'abc' })).status, 400);
  assert.equal((await a('POST', '/api/admin/password', { current: 'root', next: 'newpass' })).status, 200);
  assert.equal((await a('GET', '/api/admin/me')).data.defaultPassword, false);
  assert.equal((await client()('POST', '/api/admin/login', { password: 'root' })).status, 401);
  assert.equal((await client()('POST', '/api/admin/login', { password: 'newpass' })).status, 200);
});

test('시작 전/마감 후 투표 불가, 1인 1표, 취소, 명칭별 누적', async () => {
  const admin = client(), a = client(), b = client();
  assert.equal((await admin('POST', '/api/admin/polls', { title: '회장' })).status, 401);
  await admin('POST', '/api/admin/login', { password: 'newpass' }); // 앞 테스트에서 변경됨
  const p1 = (await admin('POST', '/api/admin/polls', { title: '회장' })).data;
  const p2 = (await admin('POST', '/api/admin/polls', { title: '총무' })).data;
  assert.equal(p1.status, 'ready');
  assert.equal((await admin('PATCH', `/api/admin/polls/${p1.id}`, { status: 'open' })).status, 409); // 후보 없음
  const k = (await admin('POST', `/api/admin/polls/${p1.id}/candidates`, { name: '김' })).data.candidates[0];
  const l = (await admin('POST', `/api/admin/polls/${p1.id}/candidates`, { name: '이' })).data.candidates[1];
  const m = (await admin('POST', `/api/admin/polls/${p2.id}/candidates`, { name: '박' })).data.candidates[0];

  assert.equal((await a('POST', `/api/polls/${p1.id}/vote`, { candidateId: k.id })).status, 409); // 시작 전
  await admin('PATCH', `/api/admin/polls/${p1.id}`, { status: 'open' });
  await admin('PATCH', `/api/admin/polls/${p2.id}`, { status: 'open' });
  assert.equal((await admin('POST', `/api/admin/polls/${p1.id}/candidates`, { name: '최' })).status, 409); // 시작 후 등록 불가

  assert.equal((await a('POST', `/api/polls/${p1.id}/vote`, { candidateId: k.id })).status, 200);
  assert.equal((await a('POST', `/api/polls/${p1.id}/vote`, { candidateId: l.id })).status, 409); // 중복
  assert.equal((await a('POST', `/api/polls/${p2.id}/vote`, { candidateId: m.id })).status, 200); // 다른 명칭은 별도 1표
  assert.equal((await b('POST', `/api/polls/${p1.id}/vote`, { candidateId: k.id })).status, 200);
  const list = (await a('GET', '/api/polls')).data;
  assert.equal(list.find((p) => p.id === p1.id).total, 2);
  assert.equal(list.find((p) => p.id === p2.id).total, 1);

  assert.equal((await a('DELETE', `/api/polls/${p1.id}/vote`)).status, 200);
  assert.equal((await a('POST', `/api/polls/${p1.id}/vote`, { candidateId: l.id })).data.myVote, l.id);

  await admin('PATCH', `/api/admin/polls/${p1.id}`, { status: 'closed' });
  assert.equal((await b('DELETE', `/api/polls/${p1.id}/vote`)).status, 409); // 마감 후 취소 불가
  assert.equal((await client()('POST', `/api/polls/${p1.id}/vote`, { candidateId: k.id })).status, 409); // 마감 후 투표 불가
  assert.equal((await admin('PATCH', `/api/admin/polls/${p1.id}`, { title: '부회장' })).data.title, '부회장');
  assert.equal((await client()('PATCH', `/api/admin/polls/${p1.id}`, { status: 'open' })).status, 401);
});
