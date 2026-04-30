// 手機 drawer：左 sidebar（題材/產業）、右 aside（新聞/法人）
// 點按鈕滑出，點遮罩或內部連結關閉

let sidebarEl, asideEl, overlayEl, leftBtn, rightBtn;

export function mount() {
  sidebarEl = document.querySelector('.sidebar');
  asideEl = document.querySelector('.aside');
  overlayEl = document.getElementById('drawer-overlay');
  leftBtn = document.getElementById('drawer-left-btn');
  rightBtn = document.getElementById('drawer-right-btn');

  if (!sidebarEl || !asideEl || !overlayEl) return;

  leftBtn?.addEventListener('click', () => toggle('left'));
  rightBtn?.addEventListener('click', () => toggle('right'));
  overlayEl.addEventListener('click', closeAll);

  // 點 sidebar / aside 內任一個股或新聞時自動關閉
  sidebarEl.addEventListener('click', (e) => {
    if (e.target.closest('.stock-row, .industry-head + .theme-stocks .stock-row')) {
      closeAll();
    }
  });
  asideEl.addEventListener('click', (e) => {
    if (e.target.closest('.news-item')) closeAll();
  });

  // ESC 關閉
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAll();
  });

  // 螢幕轉大時自動關（避免 drawer 卡住）
  const mq = window.matchMedia('(min-width: 961px)');
  mq.addEventListener?.('change', (e) => { if (e.matches) closeAll(); });
}

function toggle(side) {
  if (side === 'left') {
    const wasOpen = sidebarEl.classList.contains('open');
    closeAll();
    if (!wasOpen) {
      sidebarEl.classList.add('open');
      overlayEl.classList.add('show');
    }
  } else {
    const wasOpen = asideEl.classList.contains('open');
    closeAll();
    if (!wasOpen) {
      asideEl.classList.add('open');
      overlayEl.classList.add('show');
    }
  }
}

function closeAll() {
  sidebarEl?.classList.remove('open');
  asideEl?.classList.remove('open');
  overlayEl?.classList.remove('show');
}
