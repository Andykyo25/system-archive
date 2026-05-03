import { state, on, emit } from './state.js';
import { start as startScheduler } from './scheduler.js';
import * as topbar from './ui/topbar.js';
import * as search from './ui/search.js';
import * as drawer from './ui/drawer.js';
import * as sidebar from './ui/sidebar.js';
import * as indices from './ui/indices.js';
import * as heatmap from './ui/heatmap.js';
import * as movers from './ui/movers.js';
import * as aside from './ui/aside.js';
import * as stockPanel from './ui/stockPanel.js';
import * as ranking from './ui/ranking.js';
import * as portfolio from './ui/portfolio.js';
import * as postPanel from './ui/postPanel.js';
import * as holdings from './ui/holdings.js';
import * as backtest from './ui/backtest.js';

// ─── 啟動 ───
function boot() {
  topbar.mount();
  search.mount();
  drawer.mount();
  sidebar.mount();
  indices.mount();
  heatmap.mount();
  movers.mount();
  aside.mount();
  stockPanel.mount();
  ranking.mount();      // 短線勝率排行榜（會 emit 'ranking:updated'）
  portfolio.mount();    // AI 智選（訂閱 'ranking:updated'）
  postPanel.mount();
  holdings.mount();     // 我的持股 + 每日報告 + 每週復盤
  backtest.mount();     // Backtest 結果 + Ablation Study

  // select 事件 → stock:selected
  on('select', (code) => emit('stock:selected', code));

  // 啟動 polling
  startScheduler().then(() => {
    // 初始顯示 2330
    emit('stock:selected', state.currentCode);
  });

  // 鍵盤：/ 聚焦搜尋（暫無，預留）
  window.addEventListener('keydown', (e) => {
    if (e.key === 'r' && e.ctrlKey) {
      e.preventDefault();
      postPanel.load(true);
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
