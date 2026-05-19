import { createClient } from "@/lib/supabase/server";
import {
  updateSetting,
  upsertEtf,
  deleteEtf,
} from "./actions";

export const dynamic = "force-dynamic";

interface AppSetting {
  key: string;
  value: number | string;
  description: string | null;
  updated_at: string;
}

interface EtfMeta {
  symbol: string;
  name: string | null;
  category: string;
  expense_ratio: number | string | null;
  fund_size_billion: number | string | null;
  is_active_etf: boolean;
  notes: string | null;
}

const CATEGORIES = ["市值型", "高股息", "主題", "主動式", "債券", "其他"];

const inputCls =
  "rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none";
const btnCls =
  "rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700";
const btnDangerCls =
  "rounded-md bg-red-900/50 px-3 py-1.5 text-xs font-medium text-red-200 transition-colors hover:bg-red-900";

export default async function SettingsPage() {
  const sb = createClient();
  const [{ data: settings }, { data: etfs }] =
    await Promise.all([
      sb.from("app_settings").select("*").order("key"),
      sb.from("etf_metadata").select("*").order("symbol"),
    ]);

  const settingsList = (settings as AppSetting[] | null) ?? [];
  const etfList = (etfs as EtfMeta[] | null) ?? [];

  // 分組 settings:budget_ntd 獨立 / 其他歸「factor / 費率」
  const budgetSetting = settingsList.find((s) => s.key === "budget_ntd") ?? null;
  const defaultTopNSetting =
    settingsList.find((s) => s.key === "default_top_n") ?? null;
  const otherSettings = settingsList.filter(
    (s) => s.key !== "budget_ntd" && s.key !== "default_top_n",
  );

  return (
    <div className="space-y-10">
      <section>
        <h2 className="mb-1 text-lg font-semibold">投資預算</h2>
        <p className="mb-4 text-xs text-zinc-500">
          影響 /rank 頁:設定後只顯示「1 張成本 ≤ 預算」的標的。**單位:萬 NT$**(輸 20 = 20 萬)。設 0 = 不 filter,顯示全部。
        </p>
        {budgetSetting ? (
          <BudgetRow setting={budgetSetting} />
        ) : (
          <p className="rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-500">
            budget_ntd 設定尚未建立(套用 migration 71 後會自動出現)
          </p>
        )}
      </section>

      <section>
        <h2 className="mb-1 text-lg font-semibold">排名展示預設</h2>
        <p className="mb-4 text-xs text-zinc-500">
          影響 /rank 頁預設精選檔數(整數 5~50)。Top 5 集中度:2025 OOS alpha
          +24.19 vs Top 10 +13.80(誠實化 v2,兩年一致勝)。⚠ 受倖存者偏差
          caveat — 樂觀估計,非可交易保證。/rank 仍可用 ?focus= 臨時切。
        </p>
        {defaultTopNSetting ? (
          <DefaultTopNRow setting={defaultTopNSetting} />
        ) : (
          <p className="rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-500">
            default_top_n 設定尚未建立(套用 migration 後會自動出現)
          </p>
        )}
      </section>

      <section>
        <h2 className="mb-1 text-lg font-semibold">手續費 / 稅費 / Factor 門檻</h2>
        <p className="mb-4 text-xs text-zinc-500">
          手續費 / 證交稅影響 Dashboard 持股表;peg_threshold / roe_threshold / weights 影響 /rank 多因子排名。
        </p>
        <div className="space-y-3">
          {otherSettings.map((s) => (
            <SettingRow key={s.key} setting={s} />
          ))}
        </div>
      </section>

      <section>
        <div className="mb-1 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">ETF metadata</h2>
          <span className="text-xs text-zinc-500">{etfList.length} 檔</span>
        </div>
        <p className="mb-4 text-xs text-zinc-500">
          影響「ETF」tab。每行可改後按儲存,新增空白 row 在最下方。內扣費用 / 規模 / 類型不改不影響評分。
        </p>

        <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900">
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-800 bg-zinc-950 text-left text-xs text-zinc-400">
              <tr>
                <th className="px-2 py-2">股號</th>
                <th className="px-2 py-2">名稱</th>
                <th className="px-2 py-2">類型</th>
                <th className="px-2 py-2 text-right">內扣%</th>
                <th className="px-2 py-2 text-right">規模(億)</th>
                <th className="px-2 py-2 text-center">主動</th>
                <th className="px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {etfList.map((e) => (
                <EtfRow key={e.symbol} etf={e} isNew={false} />
              ))}
              <EtfRow key="__new__" etf={null} isNew={true} />
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function BudgetRow({ setting }: { setting: AppSetting }) {
  // budget_ntd 儲存值 = 萬 NT$(因為 app_settings.value 是 numeric(10,6),
  // 整數最多 4 位,9999.99 → 用萬單位讓 9999 萬 = 9.99 億都能存)
  const v = Number(setting.value);
  const ntd = Number.isFinite(v) && v > 0 ? Math.round(v * 10000).toLocaleString() : null;
  return (
    <form
      action={updateSetting}
      className="grid grid-cols-1 gap-2 rounded-lg border border-zinc-800 bg-zinc-900 p-3 md:grid-cols-[1fr_240px_100px]"
    >
      <div>
        <div className="font-mono text-sm text-zinc-200">{setting.key}</div>
        <div className="text-xs text-zinc-500">
          投資預算(單位:**萬** NT$)
          {ntd && <span className="ml-2 text-emerald-400">= NT$ {ntd}</span>}
        </div>
      </div>
      <input type="hidden" name="key" value={setting.key} />
      <input
        name="value"
        type="number"
        step="1"
        min="0"
        placeholder="20 = 20 萬,0 = 不 filter"
        defaultValue={String(setting.value)}
        className={inputCls}
      />
      <button className={btnCls + " w-full"}>儲存</button>
    </form>
  );
}

function DefaultTopNRow({ setting }: { setting: AppSetting }) {
  // M9.4a:整數 5~50。Top 5 集中度 2025 OOS alpha +24.19(誠實化 v2;
  //   受倖存者偏差 caveat)。預設 30 全覽。updateSetting 不做範圍檢查,
  //   靠此 input min/max + /rank 讀取端 clamp 防呆。
  const v = Number(setting.value);
  const isValid = Number.isInteger(v) && v >= 5 && v <= 50;
  return (
    <form
      action={updateSetting}
      className="grid grid-cols-1 gap-2 rounded-lg border border-zinc-800 bg-zinc-900 p-3 md:grid-cols-[1fr_240px_100px]"
    >
      <div>
        <div className="font-mono text-sm text-zinc-200">{setting.key}</div>
        <div className="text-xs text-zinc-500">
          /rank 預設精選檔數(整數 5~50)
          {isValid && (
            <span className="ml-2 text-emerald-400">= Top {Math.round(v)}</span>
          )}
        </div>
      </div>
      <input type="hidden" name="key" value={setting.key} />
      <input
        name="value"
        type="number"
        step="1"
        min="5"
        max="50"
        placeholder="5 = 集中度,30 = 全覽"
        defaultValue={String(setting.value)}
        className={inputCls}
      />
      <button className={btnCls + " w-full"}>儲存</button>
    </form>
  );
}

function SettingRow({ setting }: { setting: AppSetting }) {
  return (
    <form
      action={updateSetting}
      className="grid grid-cols-1 gap-2 rounded-lg border border-zinc-800 bg-zinc-900 p-3 md:grid-cols-[1fr_180px_100px]"
    >
      <div>
        <div className="font-mono text-sm text-zinc-200">{setting.key}</div>
        <div className="text-xs text-zinc-500">{setting.description}</div>
      </div>
      <input type="hidden" name="key" value={setting.key} />
      <input
        name="value"
        type="number"
        step="0.0001"
        defaultValue={String(setting.value)}
        className={inputCls}
      />
      <button className={btnCls + " w-full"}>儲存</button>
    </form>
  );
}

function EtfRow({ etf, isNew }: { etf: EtfMeta | null; isNew: boolean }) {
  const symbol = etf?.symbol ?? "";
  const name = etf?.name ?? "";
  const category = etf?.category ?? "市值型";
  const exp = etf?.expense_ratio == null ? "" : String(etf.expense_ratio);
  const fs = etf?.fund_size_billion == null ? "" : String(etf.fund_size_billion);
  const isActive = etf?.is_active_etf ?? false;

  return (
    <tr className="border-t border-zinc-800">
      <td className="px-2 py-2" colSpan={7}>
        <form action={upsertEtf} className="grid grid-cols-12 gap-2">
          <input
            name="symbol"
            placeholder="股號"
            defaultValue={symbol}
            readOnly={!isNew}
            required
            className={`${inputCls} col-span-2 font-mono ${isNew ? "" : "text-zinc-500"}`}
          />
          <input
            name="name"
            placeholder="名稱"
            defaultValue={name}
            className={`${inputCls} col-span-3`}
          />
          <select
            name="category"
            defaultValue={category}
            className={`${inputCls} col-span-2`}
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <input
            name="expense_ratio"
            type="number"
            step="0.01"
            placeholder="0.32"
            defaultValue={exp}
            className={`${inputCls} col-span-1 text-right`}
          />
          <input
            name="fund_size_billion"
            type="number"
            step="1"
            placeholder="100"
            defaultValue={fs}
            className={`${inputCls} col-span-1 text-right`}
          />
          <label className="col-span-1 flex items-center justify-center gap-1 text-xs text-zinc-300">
            <input type="checkbox" name="is_active_etf" defaultChecked={isActive} />
            主動
          </label>
          <button className={`${btnCls} col-span-1`}>{isNew ? "新增" : "存"}</button>
          <span className="col-span-1 text-right">
            {!isNew && (
              <DeleteEtfButton symbol={symbol} />
            )}
          </span>
        </form>
      </td>
    </tr>
  );
}

function DeleteEtfButton({ symbol }: { symbol: string }) {
  return (
    <form action={deleteEtf} className="inline">
      <input type="hidden" name="symbol" value={symbol} />
      <button className={btnDangerCls} type="submit">
        刪除
      </button>
    </form>
  );
}
