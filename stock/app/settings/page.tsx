import { TableShell, THead } from "@/app/_components/ui";
import { createClient } from "@/lib/supabase/server";
import {
  updateSetting,
  upsertEtf,
  deleteEtf,
  addCapitalFlow,
  deleteCapitalFlow,
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

// 資金流水(2026-08-28):initial_capital 只是起點,之後每次加碼入金都記在這裡。
// 不記的話 v_account_equity_daily 的 cash 會算出負數,而報酬率的分母跟著錯。
interface CapitalFlow {
  id: string;
  flow_date: string;
  amount: number | string;
  flow_type: "deposit" | "withdrawal";
  note: string | null;
}

const CATEGORIES = ["市值型", "高股息", "主題", "主動式", "債券", "其他"];

const inputCls =
  "rounded-xl border border-line-strong bg-surface-sunken px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none";
const btnCls =
  "rounded-xl bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700";
const btnDangerCls =
  "rounded-md bg-red-900/50 px-3 py-1.5 text-xs font-medium text-red-200 transition-colors hover:bg-red-900";

export default async function SettingsPage() {
  const sb = createClient();
  const [{ data: settings }, { data: etfs }, { data: flows }] =
    await Promise.all([
      sb.from("app_settings").select("*").order("key"),
      sb.from("etf_metadata").select("*").order("symbol"),
      sb
        .from("capital_flows")
        .select("id, flow_date, amount, flow_type, note")
        .order("flow_date", { ascending: false }),
    ]);

  const settingsList = (settings as AppSetting[] | null) ?? [];
  const etfList = (etfs as EtfMeta[] | null) ?? [];
  const flowList = (flows as CapitalFlow[] | null) ?? [];

  // 分組 settings:budget_ntd 獨立 / 其他歸「factor / 費率」
  const budgetSetting = settingsList.find((s) => s.key === "budget_ntd") ?? null;
  const defaultTopNSetting =
    settingsList.find((s) => s.key === "default_top_n") ?? null;
  const capitalSetting =
    settingsList.find((s) => s.key === "initial_capital") ?? null;
  const otherSettings = settingsList.filter(
    (s) =>
      s.key !== "budget_ntd" &&
      s.key !== "default_top_n" &&
      s.key !== "initial_capital",
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
          <p className="rounded-2xl border border-line bg-surface-1 p-3 text-sm text-zinc-500">
            budget_ntd 設定尚未建立(套用 migration 71 後會自動出現)
          </p>
        )}
      </section>

      <section>
        <h2 className="mb-1 text-lg font-semibold">初始本金</h2>
        <p className="mb-4 text-xs text-zinc-500">
          /performance 權益曲線的<b>起點</b>。**單位:萬 NT$**(輸 20.3004 = NT$
          203,004)。反推自交易紀錄,可手動校正為實際入金。
          <span className="text-zinc-600">
            {" "}之後每次加碼入金<b>不要改這個數字</b> —— 改了會讓歷史整條曲線位移。
            請登錄在下方「資金流水」。
          </span>
        </p>
        {capitalSetting ? (
          <CapitalRow setting={capitalSetting} />
        ) : (
          <p className="rounded-2xl border border-line bg-surface-1 p-3 text-sm text-zinc-500">
            initial_capital 設定尚未建立(套用 migration 後會自動出現)
          </p>
        )}
      </section>

      <section>
        <h2 className="mb-1 text-lg font-semibold">資金流水</h2>
        <p className="mb-4 text-xs leading-relaxed text-zinc-500">
          每一筆<b>入金 / 出金</b>。金額一律填正數,方向由類型決定。
          <span className="text-zinc-600">
            {" "}沒登錄的入金會讓 /performance 的現金算成負數,報酬率與回撤的分母就是錯的 ——
            系統會在該頁標記「不可引用」而不是顯示一個看起來合理的數字。
          </span>
        </p>
        <form
          action={addCapitalFlow}
          className="mb-3 grid grid-cols-1 gap-3 md:grid-cols-5"
        >
          <input
            name="flow_date"
            type="date"
            required
            defaultValue={new Date().toISOString().slice(0, 10)}
            className={inputCls}
          />
          <select name="flow_type" defaultValue="deposit" className={inputCls}>
            <option value="deposit">入金</option>
            <option value="withdrawal">出金</option>
          </select>
          <input
            name="amount"
            type="number"
            step="1"
            min="1"
            placeholder="金額 (元)"
            required
            className={inputCls}
          />
          <input name="note" placeholder="備註 (選填)" className={inputCls} />
          <button className={btnCls} type="submit">
            新增
          </button>
        </form>
        {flowList.length === 0 ? (
          <p className="rounded-2xl border border-amber-800/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-200/80">
            尚未登錄任何資金流水。若 /performance 顯示現金為負,就是這裡缺紀錄。
          </p>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <THead>
                <tr>
                  <th className="px-3 py-2">日期</th>
                  <th className="px-3 py-2">類型</th>
                  <th className="px-3 py-2 text-right">金額</th>
                  <th className="px-3 py-2">備註</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </THead>
              <tbody>
                {flowList.map((f) => (
                  <tr key={f.id} className="border-t border-line">
                    <td className="px-3 py-2 tabular-nums">{f.flow_date}</td>
                    <td className="px-3 py-2">
                      <span
                        className={
                          f.flow_type === "deposit"
                            ? "text-green-300"
                            : "text-amber-300"
                        }
                      >
                        {f.flow_type === "deposit" ? "入金" : "出金"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {Number(f.amount).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-zinc-500">{f.note ?? "—"}</td>
                    <td className="px-3 py-2 text-right">
                      <form action={deleteCapitalFlow} className="inline">
                        <input type="hidden" name="id" value={f.id} />
                        <button className={btnDangerCls} type="submit">
                          刪除
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </section>

      <section>
        <h2 className="mb-1 text-lg font-semibold">排名展示預設</h2>
        <p className="mb-4 text-xs text-zinc-500">
          影響 /rank 頁預設精選檔數(整數 5~50)。純顯示偏好、非績效宣稱 —
          績效一律以 /backtest 為準(早期「Top 5 集中度勝」宣稱經 PIT
          前視偏誤修正後已不成立,撤除)。/rank 仍可用 ?focus= 臨時切。
        </p>
        {defaultTopNSetting ? (
          <DefaultTopNRow setting={defaultTopNSetting} />
        ) : (
          <p className="rounded-2xl border border-line bg-surface-1 p-3 text-sm text-zinc-500">
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

        <TableShell>
          <table className="w-full text-sm">
            <THead>
              <tr>
                <th className="px-2 py-2">股號</th>
                <th className="px-2 py-2">名稱</th>
                <th className="px-2 py-2">類型</th>
                <th className="px-2 py-2 text-right">內扣%</th>
                <th className="px-2 py-2 text-right">規模(億)</th>
                <th className="px-2 py-2 text-center">主動</th>
                <th className="px-2 py-2"></th>
              </tr>
            </THead>
            <tbody>
              {etfList.map((e) => (
                <EtfRow key={e.symbol} etf={e} isNew={false} />
              ))}
              <EtfRow key="__new__" etf={null} isNew={true} />
            </tbody>
          </table>
        </TableShell>
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
      className="grid grid-cols-1 gap-2 rounded-2xl border border-line bg-surface-1 p-3 md:grid-cols-[1fr_240px_100px]"
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

function CapitalRow({ setting }: { setting: AppSetting }) {
  // 初始本金以「萬」單位存(同 budget_ntd,繞 numeric(10,6) 整數僅 4 位)。
  const v = Number(setting.value);
  const ntd =
    Number.isFinite(v) && v > 0 ? Math.round(v * 10000).toLocaleString() : null;
  return (
    <form
      action={updateSetting}
      className="grid grid-cols-1 gap-2 rounded-2xl border border-line bg-surface-1 p-3 md:grid-cols-[1fr_240px_100px]"
    >
      <div>
        <div className="font-mono text-sm text-zinc-200">{setting.key}</div>
        <div className="text-xs text-zinc-500">
          初始本金(單位:**萬** NT$)
          {ntd && <span className="ml-2 text-emerald-400">= NT$ {ntd}</span>}
        </div>
      </div>
      <input type="hidden" name="key" value={setting.key} />
      <input
        name="value"
        type="number"
        step="0.0001"
        min="0"
        placeholder="20.3004 = NT$ 203,004"
        defaultValue={String(setting.value)}
        className={inputCls}
      />
      <button className={btnCls + " w-full"}>儲存</button>
    </form>
  );
}

function DefaultTopNRow({ setting }: { setting: AppSetting }) {
  // M9.4a:整數 5~50,純顯示偏好、非績效宣稱(早期「top5 集中度勝」宣稱
  //   經 PIT 前視偏誤修正後已不成立,見 L48;績效以 /backtest 為準)。
  //   預設 30 全覽。updateSetting 不做範圍檢查,靠此 input min/max +
  //   /rank 讀取端 clamp 防呆。
  const v = Number(setting.value);
  const isValid = Number.isInteger(v) && v >= 5 && v <= 50;
  return (
    <form
      action={updateSetting}
      className="grid grid-cols-1 gap-2 rounded-2xl border border-line bg-surface-1 p-3 md:grid-cols-[1fr_240px_100px]"
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
      className="grid grid-cols-1 gap-2 rounded-2xl border border-line bg-surface-1 p-3 md:grid-cols-[1fr_180px_100px]"
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
    <tr className="border-t border-line-soft">
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
