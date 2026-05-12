"use client";

import { useTransition } from "react";
import { deleteTransaction } from "./actions";

interface Props {
  id: string;
  label: string; // e.g. "2330 買 1000 股 @ 600"
}

export function DeleteTxnButton({ id, label }: Props) {
  const [pending, startTransition] = useTransition();

  function onClick() {
    if (!confirm(`確定刪除這筆交易?\n\n${label}\n\n如果後面有 SELL,均價會重算。`)) return;
    const fd = new FormData();
    fd.set("id", id);
    startTransition(async () => {
      try {
        await deleteTransaction(fd);
      } catch (e) {
        alert(`刪除失敗:${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className="rounded-md border border-red-900 bg-red-950/40 px-2.5 py-1 text-xs font-medium text-red-300 transition-colors hover:bg-red-900/60 hover:text-red-100 disabled:opacity-50"
    >
      {pending ? "刪除中…" : "刪除"}
    </button>
  );
}
