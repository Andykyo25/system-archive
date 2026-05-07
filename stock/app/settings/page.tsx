import { createClient } from "@/lib/supabase/server";
import {
  updateSetting,
  updateForecasts,
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

interface IndustryStockForecast {
  symbol: string;
  name: string | null;
  analyst_forecast_eps_growth_pct: number | string | null;
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
  const [{ data: settings }, { data: forecasts }, { data: etfs }] =
    await Promise.all([
      sb.from("app_settings").select("*").order("key"),
      sb
        .from("industry_stocks")
        .select("symbol, name, analyst_forecast_eps_growth_pct")
        .order("symbol"),
      sb.from("etf_metadata").select("*").order("symbol"),
    ]);

  const settingsList = (settings as AppSetting[] | null) ?? [];
  const allForecasts = (forecasts as IndustryStockForecast[] | null) ?? [];
  const etfList = (etfs as EtfMeta[] | null) ?? [];

  const seen = new Set<string>();
  const uniqueForecasts = allForecasts.filter((r) => {
    if (seen.has(r.symbol)) return false;
    seen.add(r.symbol);
    return true;
  });
  const withForecast = uniqueForecasts.filter(
    (r) => r.analyst_forecast_eps_growth_pct != null,
  );
  const forecastsText = withForecast
    .map(
      (r) =>
        `${r.symbol}=${r.analyst_forecast_eps_growth_pct}  # ${r.name ?? ""}`,
    )
    .join("\n");

  return (
    <div className="space-y-10">
      <section>
        <h2 className="mb-1 text-lg font-semibold">手續費 / 稅費</h2>
        <p className="mb-4 text-xs text-zinc-500">
          影響:Dashboard 持股表「淨損益(估)」、總計卡的「未實現淨損益」
        </p>
        <div className="space-y-3">
          {settingsList.map((s) => (
            <SettingRow key={s.key} setting={s} />
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-1 text-lg font-semibold">法人 EPS 成長預估(批次)</h2>
        <p className="mb-1 text-xs text-zinc-500">
          覆蓋 PEG 計算優先序:有填這個就用 forecast,沒填就 fallback 到「最近一季 EPS YoY」。
        </p>
        <p className="mb-4 text-xs text-zinc-500">
          格式:每行一筆 <code className="rounded bg-zinc-800 px-1">股號=百分比</code>。
          清掉用 <code className="rounded bg-zinc-800 px-1">股號=null</code>。# 後為註解。
        </p>
        <form action={updateForecasts} className="space-y-3">
          <textarea
            name="forecasts"
            rows={Math.max(8, withForecast.length + 2)}
            defaultValue={forecastsText}
            placeholder={"# 範例\n2454=100  # 聯發科 法人預估 2027 EPS YoY 100%"}
            className={`${inputCls} w-full font-mono`}
          />
          <button className={btnCls}>儲存所有預估值</button>
        </form>
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
