// 의존성 없는 투표 플랫폼 서버 (Node 18+)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const DEFAULT_PASSWORD = 'root';

export function createApp({ dataFile }) {
  // ---------- 저장소 (JSON 파일, 원자적 쓰기) ----------
  // poll: {id,title,description,status:'ready'|'open'|'closed',candidates:[{id,name,description}],votes:{voterHash:candidateId}}
  let db = { polls: [], admin: null };
  if (dataFile && fs.existsSync(dataFile)) db = { ...db, ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) };
  const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
  const setPassword = (pw) => {
    const salt = crypto.randomBytes(16).toString('hex');
    db.admin = { salt, hash: hashPw(pw, salt), isDefault: pw === DEFAULT_PASSWORD };
  };
  const checkPassword = (pw) => {
    const a = Buffer.from(hashPw(String(pw ?? ''), db.admin.salt), 'hex');
    return crypto.timingSafeEqual(a, Buffer.from(db.admin.hash, 'hex'));
  };
  const save = () => {
    if (!dataFile) return;
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, dataFile);
  };

  const failures = new Map(); // 로그인 실패 제한 (ip → {n, until})
  if (!db.admin) { setPassword(DEFAULT_PASSWORD); save(); }
  const uid = () => crypto.randomBytes(6).toString('hex');
  const hash = (v) => crypto.createHash('sha256').update(v).digest('hex');
  const sessions = new Set(); // 관리자 세션 토큰

  // ---------- 유틸 ----------
  const parseCookies = (req) =>
    Object.fromEntries(
      (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, v.join('=')])
    );
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };
  const readJson = (req) =>
    new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (c) => {
        data += c;
        if (data.length > 20_000) { reject(Object.assign(new Error('요청이 너무 큽니다'), { status: 413 })); req.destroy(); }
      });
      req.on('end', () => {
        if (!data) return resolve({});
        try { resolve(JSON.parse(data)); } catch { reject(Object.assign(new Error('잘못된 JSON'), { status: 400 })); }
      });
    });
  const clean = (s, max) => (typeof s === 'string' ? s.trim().slice(0, max) : '');
  const fail = (status, message) => Object.assign(new Error(message), { status });

  const publicPoll = (p, voterHash) => {
    const counts = {};
    for (const cid of Object.values(p.votes)) counts[cid] = (counts[cid] || 0) + 1;
    return {
      id: p.id, title: p.title, description: p.description, status: p.status,
      total: Object.keys(p.votes).length,
      myVote: p.votes[voterHash] ?? null,
      candidates: p.candidates.map((c) => ({ ...c, votes: counts[c.id] || 0 })),
    };
  };

  // ---------- API ----------
  async function api(req, res, url) {
    const cookies = parseCookies(req);
    const setCookies = [];

    // 방문자 식별: 로그인 대신 브라우저별 랜덤 ID 쿠키
    let voterId = cookies.voter_id;
    if (!voterId || !/^[a-f0-9]{32}$/.test(voterId)) {
      voterId = crypto.randomBytes(16).toString('hex');
      setCookies.push(`voter_id=${voterId}; Path=/; Max-Age=315360000; HttpOnly; SameSite=Strict`);
    }
    const voterHash = hash(voterId);
    const isAdmin = sessions.has(cookies.admin_token);
    const reply = (status, body) => send(res, status, body, setCookies.length ? { 'Set-Cookie': setCookies } : {});

    const method = req.method;
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // 'api' 제거

    // CSRF 방어: 변경 요청은 JSON만 허용 (SameSite=Strict 쿠키와 함께)
    const body = method === 'GET' || method === 'DELETE' ? {} : await readJson(req);
    if (method !== 'GET' && !(req.headers['x-requested-with'] === 'fetch')) throw fail(403, '잘못된 요청입니다');

    const findPoll = (id) => {
      const p = db.polls.find((x) => x.id === id);
      if (!p) throw fail(404, '투표를 찾을 수 없습니다');
      return p;
    };
    const requireAdmin = () => { if (!isAdmin) throw fail(401, '관리자 인증이 필요합니다'); };

    // --- 공개 ---
    if (method === 'GET' && parts[0] === 'polls' && parts.length === 1)
      return reply(200, db.polls.map((p) => publicPoll(p, voterHash)));

    if (parts[0] === 'polls' && parts[2] === 'vote') {
      const p = findPoll(parts[1]);
      if (method === 'POST') {
        if (p.status === 'ready') throw fail(409, '아직 투표가 시작되지 않았습니다');
        if (p.status === 'closed') throw fail(409, '마감된 투표입니다');
        if (p.votes[voterHash]) throw fail(409, '이미 투표하셨습니다. 변경하려면 먼저 투표를 취소하세요');
        if (!p.candidates.some((c) => c.id === body.candidateId)) throw fail(400, '존재하지 않는 후보입니다');
        p.votes[voterHash] = body.candidateId;
        save();
        return reply(200, publicPoll(p, voterHash));
      }
      if (method === 'DELETE') {
        if (p.status !== 'open') throw fail(409, '진행 중인 투표만 취소할 수 있습니다');
        if (!p.votes[voterHash]) throw fail(404, '취소할 투표가 없습니다');
        delete p.votes[voterHash];
        save();
        return reply(200, publicPoll(p, voterHash));
      }
    }

    // --- 관리자 ---
    if (parts[0] === 'admin') {
      if (method === 'POST' && parts[1] === 'login') {
        const ip = req.socket.remoteAddress;
        const f = failures.get(ip);
        if (f && f.n >= 10 && f.until > Date.now()) throw fail(429, '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요');
        if (!checkPassword(body.password)) {
          failures.set(ip, { n: (f && f.until > Date.now() ? f.n : 0) + 1, until: Date.now() + 10 * 60_000 });
          await new Promise((r) => setTimeout(r, 500));
          throw fail(401, '비밀번호가 올바르지 않습니다');
        }
        failures.delete(ip);
        const token = crypto.randomBytes(24).toString('hex');
        sessions.add(token);
        setCookies.push(`admin_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800`);
        return reply(200, { ok: true });
      }
      if (method === 'POST' && parts[1] === 'logout') {
        sessions.delete(cookies.admin_token);
        setCookies.push('admin_token=; Path=/; Max-Age=0');
        return reply(200, { ok: true });
      }
      if (method === 'GET' && parts[1] === 'me') return reply(200, { admin: isAdmin, defaultPassword: isAdmin && db.admin.isDefault });

      requireAdmin();
      if (method === 'POST' && parts[1] === 'password') {
        if (!checkPassword(body.current)) throw fail(401, '현재 비밀번호가 올바르지 않습니다');
        const next = typeof body.next === 'string' ? body.next : '';
        if (next.length < 4 || next.length > 100) throw fail(400, '새 비밀번호는 4자 이상이어야 합니다');
        setPassword(next); save();
        return reply(200, { ok: true });
      }
      if (method === 'POST' && parts[1] === 'polls' && parts.length === 2) {
        const title = clean(body.title, 100);
        if (!title) throw fail(400, '제목을 입력하세요');
        const p = { id: uid(), title, description: clean(body.description, 500), status: 'ready', candidates: [], votes: {} };
        db.polls.push(p); save();
        return reply(201, publicPoll(p, voterHash));
      }
      if (parts[1] === 'polls' && parts[2]) {
        const p = findPoll(parts[2]);
        if (method === 'PATCH' && parts.length === 3) {
          if (body.title !== undefined) {
            const t = clean(body.title, 100);
            if (!t) throw fail(400, '투표 명칭을 입력하세요');
            p.title = t;
          }
          if (body.status !== undefined) {
            if (body.status === 'open' && p.status === 'ready') {
              if (!p.candidates.length) throw fail(409, '후보를 먼저 등록하세요');
              p.status = 'open';
            } else if (body.status === 'closed' && p.status === 'open') p.status = 'closed';
            else throw fail(409, '변경할 수 없는 상태입니다');
          }
          save();
          return reply(200, publicPoll(p, voterHash));
        }
        if (method === 'DELETE' && parts.length === 3) {
          db.polls = db.polls.filter((x) => x !== p); save();
          return reply(200, { ok: true });
        }
        if (method === 'POST' && parts[3] === 'candidates') {
          if (p.status !== 'ready') throw fail(409, '투표 시작 후에는 후보를 등록할 수 없습니다');
          const name = clean(body.name, 50);
          if (!name) throw fail(400, '후보 이름을 입력하세요');
          if (p.candidates.some((c) => c.name === name)) throw fail(409, '이미 등록된 후보입니다');
          p.candidates.push({ id: uid(), name, description: clean(body.description, 200) });
          save();
          return reply(201, publicPoll(p, voterHash));
        }
        if (method === 'DELETE' && parts[3] === 'candidates' && parts[4]) {
          if (p.status !== 'ready') throw fail(409, '투표 시작 후에는 후보를 삭제할 수 없습니다');
          p.candidates = p.candidates.filter((c) => c.id !== parts[4]);
          for (const [k, v] of Object.entries(p.votes)) if (v === parts[4]) delete p.votes[k];
          save();
          return reply(200, publicPoll(p, voterHash));
        }
      }
    }
    throw fail(404, 'Not found');
  }

  // ---------- 정적 파일 ----------
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      serveStatic(req, res, url);
    } catch (e) {
      send(res, e.status || 500, { error: e.status ? e.message : '서버 오류' });
      if (!e.status) console.error(e);
    }
  });
}

// ---------- 실행 ----------
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const dataFile = process.env.DATA_FILE || path.join(__dirname, 'data.json');
  createApp({ dataFile }).listen(port, () => console.log(`투표 플랫폼: http://localhost:${port}  (관리자 기본 비밀번호: root — 첫 로그인 후 변경하세요)`));
}
