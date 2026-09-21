// Run after next build. Isolated HTTP fixtures: no live database or transactions.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const calls = { scan: 0, head: 0, risk: 0, plans: 0 };
const rows = Array.from({ length: 1001 }, (_, i) => ({
  symbol: String(1000 + i), name: `Fixture ${i}`, industry_category: '測試',
  trade_date: '2026-09-21', close: 50, day_pct: 8, volume_lots: 6000,
  ma20: 48, ma20_gap_pct: 4, ma20_slope_pct: 2, high_20d: 49,
  rsi14: 60, ret_5d_pct: 5, score_surge: 34, score_position: 33,
  score_momentum: 33, score_total: i === 0 ? 90 : 70,
  passes_all: i === 0, fgn_net_5d: 1000, atr14: 2,
}));
const mock = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname.split('/').pop();
  res.setHeader('Content-Type', 'application/json');
  let data = [];
  if (route === 'v_breakout_scan') {
    if (req.method === 'HEAD') {
      calls.head++;
      res.writeHead(504); res.end(); return;
    }
    calls.scan++;
    const start = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 1000);
    const selected = url.searchParams.has("score_total") ? rows.filter(row => row.score_total >= 80) : rows;
    data = selected.slice(start, start + limit);
  } else if (route === 'price_daily') data = [{ trade_date: '2026-09-21' }];
  else if (route === 'trade_plans') calls.plans++;
  else if (route === 'v_plan_risk_context') { calls.risk++; data = null; }
  else if (route === 'v_scan_track_v2') {
    await new Promise(resolve => setTimeout(resolve, 1800));
    res.writeHead(503); res.end(JSON.stringify({ message: 'fixture tracking unavailable' })); return;
  }
  res.end(JSON.stringify(data));
});
await new Promise(resolve => mock.listen(4192, '127.0.0.1', resolve));
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3192'], {
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:4192', SUPABASE_SERVICE_ROLE_KEY: 'fixture-only', NODE_ENV: 'production' },
});
let logs = '';
child.stdout.on('data', b => logs += b);
child.stderr.on('data', b => logs += b);
try {
  for (let i = 0; i < 80 && !logs.includes('Ready in'); i++) {
    if (child.exitCode != null) throw new Error(logs);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  async function load() {
    const start = Date.now();
    const response = await fetch('http://127.0.0.1:3192/scan');
    let html = '', boardMs = null;
    for await (const chunk of response.body) {
      html += Buffer.from(chunk).toString();
      if (boardMs == null && html.includes('Fixture 0')) boardMs = Date.now() - start;
    }
    assert.ok(html.includes('Fixture 0'), 'candidate renders');
    assert.ok(html.replace(/<!--.*?-->/g, '').includes('1001 檔'), 'count includes second page');
    assert.ok(!html.includes('Fixture 1<'), 'low-score stocks stay excluded');
    assert.ok(html.includes('前向追蹤載入失敗'), 'failed statistics are explicit and contained');
    assert.ok(!/"digest":"\d+"/.test(html), 'no page-level render failure');
    return { boardMs, totalMs: Date.now() - start };
  }
  const first = await load();
  assert.ok(first.boardMs < first.totalMs - 800, 'candidates stream before slow statistics');
  const reads = calls.scan;
  await load();
  assert.equal(calls.scan, reads, 'successful market results are cached');
  assert.equal(calls.head, 0, 'no failing exact HEAD query');
  assert.equal(calls.risk, 2, 'account risk remains fresh');
  assert.equal(calls.plans, 2, 'plans remain fresh');
  console.log('PASS: pagination, score filter, shared count, cache, fresh account data, streamed statistics failure', first);
} catch (error) { console.error(logs); throw error; }
finally { child.kill(); mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)); }
