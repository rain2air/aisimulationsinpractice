export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `오류 (${res.status})`);
  return data;
}
export function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), 2500);
}
export const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k != null));
  return e;
};
export const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };
// 후보 목록 + 득표 막대 렌더링
export function candidateRows(poll, actionFor) {
  return poll.candidates.map((c) => {
    const pct = poll.total ? Math.round((c.votes / poll.total) * 100) : 0;
    const mine = poll.myVote === c.id;
    return el('div', { className: 'cand' + (mine ? ' mine' : '') },
      el('div', { className: 'info' },
        el('div', { className: 'name' }, c.name, mine ? ' ✅ 내 선택' : ''),
        c.description ? el('div', { className: 'muted' }, c.description) : null,
        el('div', { className: 'bar' }, el('i', { style: `width:${pct}%` })),
        el('div', { className: 'muted' }, `${c.votes}표 (${pct}%)`)),
      actionFor(c));
  });
}
