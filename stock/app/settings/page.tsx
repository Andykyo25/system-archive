import { createClient } from "@/lib/supabase/server";
import { updateSetting, updateForecasts } from "./actions";

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

const inputCls =
  "rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none";
const btnCls =
  "rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700";

export default async function SettingsPage() {
  const sb = createClient();
  const [{ data: settings }, { data: forecasts }] = await Promise.all([
    sb.from("app_settings").select("*").order("key"),
    sb
      .from("industry_stocks")
      .select("symbol, name, analyst_forecast_eps_growth_pct")
      .order("symbol"),
  ]);

  const settingsList = (settings as AppSetting[] | null) ?? [];
  const allForecasts = (forecasts as IndustryStockForecast[] | null) ?? [];

  // 同 symbol 取一筆 forecast(industry_stocks 同股可能在多產業)
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
    <div className="space-y-8">
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
          格式:每行一筆 <code className="rounded bg-zinc-800 px-1">股號=百分比</code>
          (e.g. <code className="rounded bg-zinc-800 px-1">2454=100</code>),
          要清掉設 <code className="rounded bg-zinc-800 px-1">2454=null</code> 或 <code className="rounded bg-zinc-800 px-1">2454=-</code>。
          # 開頭為註解。
        </p>
        <form action={updateForecasts} className="space-y-3">
          <textarea
            name="forecasts"
            rows={Math.max(8, withForecast.length + 2)}
            defaultValue={forecastsText}
            placeholder={"# 範例\n2454=100  # 聯發科,法人預估 2027 EPS YoY 100%\n3231=80   # 緯創"}
            className={`${inputCls} w-full font-mono`}
          />
          <button className={btnCls}>儲存所有預估值</button>
        </form>
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
      <button className={btnCls}>儲存</button>
    </form>
  );
}
