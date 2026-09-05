/**
 * 증권사 수수료 변경 감시 + 이벤트 만료 알림
 *
 * ① 요율 지문   — 수수료 안내 페이지의 요율 집합을 비교
 * ② 만료 캘린더 — 이벤트 종료 예정일 D-14 / D-7 / D-Day / 경과 알림
 *
 * 감지만 한다. 표를 자동으로 고치지 않는다 —
 * 갱신되지 않은 값이 남아 있는 페이지, 본문이 이미지인 이벤트 페이지가 실재하므로
 * 자동 갱신하면 틀린 숫자가 그대로 공개된다.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { constants } from 'node:crypto';

const DIR = dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(readFileSync(join(DIR, 'targets.json'), 'utf8'));
const TARGETS = CFG.targets;
const DL = JSON.parse(readFileSync(join(DIR, 'deadlines.json'), 'utf8'));
const BASE_PATH = join(DIR, 'baseline.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const TIMEOUT = 20000;

/* 주제별 수치 패턴 — 수수료는 0.0036396 형태, 금리는 2.45 형태로 서로 다르다 */
const PATTERNS = {
  fee:  { re: /(?<![\d.])0\.[0-9]{2,7}(?![\d])/g, min: 0.0005, max: 0.95 },
  rate: { re: /(?<![\d.])[0-9]\.[0-9]{1,2}(?![\d])/g, min: 0.5, max: 8 },
};
const P = PATTERNS[CFG.pattern] || PATTERNS.fee;

function fingerprint(text, mode) {
  const plain = text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  const nums = (plain.match(P.re) || []).map(Number).filter(n => n >= P.min && n <= P.max);
  if (mode === 'first') return nums.length ? [nums[0]] : [];
  return [...new Set(nums)].sort((a, b) => a - b);
}

function legacyGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9' },
      secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT,
      rejectUnauthorized: false,
      timeout: TIMEOUT,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('타임아웃')));
  });
}

async function grab(t) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    if (t.legacyTls) {
      const r = await legacyGet(t.url);
      if (r.status !== 200) return { error: `HTTP ${r.status}` };
      let text;
      try { text = new TextDecoder(t.encoding || 'utf-8').decode(r.buf); }
      catch { text = r.buf.toString('utf8'); }
      const rates = fingerprint(text, t.mode);
      if (!rates.length) return { error: '수치 0개 수집 — 점검 안내·차단·JS 렌더링 가능성' };
      return { rates };
    }
    const res = await fetch(t.url, {
      method: t.method || 'GET',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/json,*/*',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        ...(t.method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: t.method === 'POST' ? '' : undefined,
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    let enc = t.encoding;
    if (!enc) {
      const ct = res.headers.get('content-type') || '';
      const m = ct.match(/charset=([\w-]+)/i);
      enc = m ? m[1].toLowerCase() : 'utf-8';
      if (enc === 'utf-8') {
        const head = buf.subarray(0, 3000).toString('latin1');
        if (/charset=["']?(euc-kr|ks_c_5601)/i.test(head)) enc = 'euc-kr';
      }
    }
    let text;
    try { text = new TextDecoder(enc).decode(buf); }
    catch { text = buf.toString('utf8'); }
    const rates = fingerprint(text, t.mode);
    // 수치를 하나도 못 뽑았으면 성공이 아니라 실패다.
    // 점검 안내 페이지·차단·JS 주입으로 본문이 비면 여기에 걸린다.
    // 이걸 성공으로 저장하면 baseline이 빈 값으로 덮이고, 이후 요율이 바뀌어도 영원히 "그대로"가 나온다.
    if (!rates.length) return { error: '수치 0개 수집 — 점검 안내·차단·JS 렌더링 가능성' };
    return { rates };
  } catch (e) {
    return { error: e.name === 'AbortError' ? '타임아웃' : String(e.message || e).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

const base = existsSync(BASE_PATH) ? JSON.parse(readFileSync(BASE_PATH, 'utf8')) : { targets: {} };
const kst = new Date(Date.now() + 9 * 3600 * 1000);
const today = kst.toISOString().slice(0, 10);
const now = `${today} ${kst.toISOString().slice(11, 16)} KST`;

/* ── ① 요율 지문 ── */
const next = { checked_at: now, targets: {} };
const changed = [];
const errors = [];

for (const t of TARGETS) {
  const r = await grab(t);
  const prev = base.targets?.[t.id];

  if (r.error) {
    errors.push({ ...t, error: r.error });
    // 이전 값을 그대로 보존한다. 빈 값으로 덮으면 다음 실행부터 조용해진다.
    // 이전 값이 아예 없으면 키를 만들지 않아 다음에 '최초 수집'으로 잡히게 둔다.
    if (prev) next.targets[t.id] = prev;
    console.log(`✗ ${t.label} — ${r.error}`);
    continue;
  }
  next.targets[t.id] = { rates: r.rates, checked_at: now };

  if (prev?.rates) {
    const a = new Set(prev.rates), b = new Set(r.rates);
    const added = r.rates.filter(x => !a.has(x));
    const removed = prev.rates.filter(x => !b.has(x));
    if (added.length || removed.length) {
      changed.push({ ...t, added, removed });
      console.log(`● ${t.label} — 변경 (+${added.length} / -${removed.length})`);
    } else console.log(`· ${t.label} — 그대로`);
  } else console.log(`+ ${t.label} — 최초 수집 (${r.rates.length}개)`);
}

writeFileSync(BASE_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');

/* ── ② 만료 캘린더 ── */
const days = d => Math.round((new Date(d + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 86400000);
const due = [];
for (const d of DL.deadlines) {
  const left = days(d.end);
  if (left < 0) { if (left >= -30) due.push({ ...d, left, kind: '경과' }); continue; }
  if (DL.alertDays.includes(left)) due.push({ ...d, left, kind: left === 0 ? '오늘 종료' : `D-${left}` });
}

/* ── 리포트 ── */
const t1 = changed.filter(c => c.tier === 1);
const lines = [];

if (due.length) {
  lines.push('## 📅 이벤트 종료 예정', '');
  lines.push('| 상태 | 이벤트 | 종료일 | 종료 후 |', '|---|---|---|---|');
  for (const d of due) {
    const st = d.left < 0 ? `⚠️ ${-d.left}일 경과` : (d.left === 0 ? '🔴 오늘 종료' : `🟠 ${d.kind}`);
    lines.push(`| ${st} | ${d.label}${d.scope ? ` (${d.scope})` : ''} | ${d.end} | ${d.after || '–'} |`);
  }
  lines.push('', '> 종료 후 요율이 바뀌는 항목은 **표를 고쳐야 합니다.** 새 회차가 나왔는지도 함께 확인하세요.', '');
}

if (changed.length) {
  lines.push(t1.length ? '## 🚨 주요 증권사 요율 변경' : '## 요율 변경 감지', '');
  lines.push('| 대상 | 새로 생긴 값 | 사라진 값 |', '|---|---|---|');
  for (const c of changed) {
    const f = a => a.length ? a.slice(0, 8).join(', ') + (a.length > 8 ? ` 외 ${a.length - 8}` : '') : '–';
    lines.push(`| ${c.tier === 1 ? '🚨 ' : ''}[${c.label}](${c.url}) | ${f(c.added)} | ${f(c.removed)} |`);
  }
  lines.push('');
  lines.push('> 숫자 지문 비교라 **오탐이 있을 수 있습니다.** 링크를 열어 실제 요율과 계좌 종류·매체를 직접 확인하세요.');
  lines.push('> 유관기관제비용 **포함/별도**가 바뀌면 표기 요율이 그대로여도 실부담이 달라집니다.', '');
}

if (errors.length) {
  lines.push('## 수집 실패', '');
  for (const e of errors) lines.push(`- ${e.label} — ${e.error}`);
  lines.push('', '> 실패한 대상은 **이전 값을 그대로 유지**했습니다. 감시가 멈춘 상태이므로 그 증권사는 직접 확인해야 합니다.');
  lines.push('> `수치 0개 수집`은 접속은 됐지만 본문이 비었다는 뜻입니다 — 시스템 점검 안내, 차단, JS 렌더링 전환 중 하나입니다.');
  lines.push('> 며칠 이상 반복되면 URL이 바뀌었거나 감시 대상에서 빼야 하는 페이지입니다.', '');
}

if (!due.length && !changed.length && !errors.length) lines.push(`변경 없음 · ${now}`);

lines.push('---');
lines.push('환전 우대율·신규계좌 이벤트는 본문이 이미지이거나 회차마다 URL이 바뀌어 자동 감시 대상이 아닙니다. 분기 갱신 때 직접 확인하세요.');

const report = lines.join('\n');
writeFileSync(join(DIR, 'report.md'), report + '\n', 'utf8');

if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n', { flag: 'a' });
if (process.env.GITHUB_OUTPUT) {
  const parts = [];
  if (due.length) parts.push(`만료 ${due.length}건`);
  if (changed.length) parts.push(`요율 변경 ${changed.length}건`);
  const title = (t1.length ? '🚨 ' : (due.length ? '📅 ' : '')) + `수수료 감시 — ${parts.join(' · ')} (${today})`;
  writeFileSync(process.env.GITHUB_OUTPUT,
    `changed=${changed.length > 0 || due.length > 0}\ntier1=${t1.length > 0}\ntitle=${title}\n`, { flag: 'a' });
}

console.log(`\n총 ${TARGETS.length}곳 · 요율변경 ${changed.length} · 실패 ${errors.length} · 만료알림 ${due.length}`);
