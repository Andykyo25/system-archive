'use client';
import { useEffect, useRef, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';

export function LiveRefresh() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const busy = useRef(false);
  useEffect(() => { busy.current = pending; }, [pending]);
  useEffect(() => {
    let last = Date.now();
    const update = () => {
      const editing = document.activeElement?.closest('input,select,textarea,[contenteditable="true"],form') || document.querySelector('details[open] form,[role="dialog"]');
      if (document.visibilityState !== 'visible' || busy.current || editing || Date.now()-last<55_000) return;
      last=Date.now();
      startTransition(()=>router.refresh());
    };
    const id=setInterval(update,60_000);
    document.addEventListener('visibilitychange',update);
    window.addEventListener('focus',update);
    return ()=> {clearInterval(id); document.removeEventListener('visibilitychange',update); window.removeEventListener('focus',update);};
  },[router]);
  return <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-300">
    <span>每分鐘檢查更新 · 資料時間以各來源為準 · 填寫表單時暫停</span>
    <button type="button" disabled={pending} onClick={()=>startTransition(()=>router.refresh())} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-line-strong px-3 text-slate-200 hover:bg-surface-2 disabled:opacity-50">
      <RefreshCw size={14} aria-hidden className={pending?'animate-spin':''}/>{pending?'讀取中':'更新資料'}
    </button>
  </div>;
}
