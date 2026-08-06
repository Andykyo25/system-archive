/**
 * Supabase Edge Function: line-notify
 * 每日自動查詢出發預警 & 開票預警,按使用者分組,各自推播到自己的 LINE
 * (多使用者隔離:每個業務只會收到自己紀錄的提醒)
 *
 * 收件人對應:public.line_recipients(user_id → line_user_id),由管理員維護
 *
 * 必要環境變數(Supabase Dashboard → Edge Functions → Secrets):
 *   LINE_CHANNEL_TOKEN        — LINE Messaging API Channel Access Token
 *   CRON_SECRET               — 自訂密鑰,防止外部任意觸發
 *   SUPABASE_URL              — 自動注入,無需手動設定
 *   SUPABASE_SERVICE_ROLE_KEY — 自動注入,無需手動設定
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

interface DepRecord {
  user_id: string
  name: string
  tour: string
  date: string
  deposit: boolean | null
  balance: boolean | null
  preTripNotify: boolean | null
  contractUploaded: boolean | null
  contractImage: string | null
}

interface TickRecord {
  user_id: string
  name: string
  tour: string
  date: string            // 用於排除已出發
  ticketingDate: string
  list: boolean | null
}

interface Recipient {
  user_id: string
  line_user_id: string
}

// 合約完成判定:有截圖,或 v12(2026-07-27)前的舊勾選(grandfather)。
// 必須與前端 業務出團表紀錄系統.html 的 contractDone() 保持一致。
function contractDone(r: DepRecord): boolean {
  return !!r.contractImage || r.contractUploaded === true
}

function getTaiwanDateStr(offsetDays = 0): string {
  const now = new Date()
  const tw  = new Date(now.getTime() + 8 * 60 * 60 * 1000)
  tw.setDate(tw.getDate() + offsetDays)
  return tw.toISOString().split('T')[0]
}

function buildMessage(todayStr: string, depItems: DepRecord[], tickItems: TickRecord[]): string {
  const lines: string[] = [
    '📋 業務出團每日提醒',
    `📅 ${todayStr}`,
    '━━━━━━━━━━━━━━━━━━━━',
  ]

  if (depItems.length === 0 && tickItems.length === 0) {
    lines.push('\n✅ 今日無待辦事項,請安心出團!')
    lines.push('\n━━━━━━━━━━━━━━━━━━━━')
    lines.push('共 0 筆出發預警 / 0 筆開票預警')
  } else {
    if (depItems.length > 0) {
      lines.push('\n⚠️ 3天內出發－待辦未完成:')
      depItems.forEach((r) => {
        const issues: string[] = []
        if (!r.deposit)       issues.push('❌ 未收訂金')
        if (!r.balance)       issues.push('❌ 未收尾款')
        if (!r.preTripNotify) issues.push('❌ 未發行前通知')
        if (!contractDone(r)) issues.push('❌ 合約尚未上傳')
        lines.push(`\n👤 ${r.name}`)
        lines.push(`🗺️  ${r.tour}`)
        lines.push(`🛫 出發:${r.date}`)
        lines.push(issues.join('  '))
      })
    }

    if (tickItems.length > 0) {
      lines.push('\n\n🎫 開票日前3天－名單未入:')
      tickItems.forEach((r) => {
        lines.push(`\n👤 ${r.name}`)
        lines.push(`🗺️  ${r.tour}`)
        lines.push(`📝 開票日:${r.ticketingDate}`)
        lines.push(`🛫 出發:${r.date}`)
      })
    }

    lines.push('\n━━━━━━━━━━━━━━━━━━━━')
    lines.push(`共 ${depItems.length} 筆出發預警 / ${tickItems.length} 筆開票預警`)
  }

  return lines.join('\n')
}

async function sendLine(token: string, userId: string, text: string): Promise<void> {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type' : 'application/json',
    },
    body: JSON.stringify({
      to      : userId,
      messages: [{ type: 'text', text }],
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`LINE API 錯誤 ${res.status}: ${body}`)
  }
}

Deno.serve(async (req: Request) => {
  try {
    // ① 驗證 CRON_SECRET
    const cronSecret = Deno.env.get('CRON_SECRET') ?? ''
    const cronHeader = req.headers.get('x-cron-secret') ?? ''
    if (cronSecret && cronHeader !== cronSecret) {
      return new Response('Unauthorized', { status: 401 })
    }

    // ② 建立 Supabase 客戶端(service role,繞過 RLS,由本函式自行分組隔離)
    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // ③ 讀收件人對應表;空表就不發任何訊息
    const { data: recRaw, error: recErr } = await sb
      .from('line_recipients')
      .select('user_id, line_user_id')
    if (recErr) throw recErr
    const recipients: Recipient[] = recRaw ?? []

    if (recipients.length === 0) {
      return new Response(
        JSON.stringify({ success: true, notified: 0, note: 'line_recipients 為空,未發送任何訊息' }),
        { headers: { 'Content-Type': 'application/json' } },
      )
    }

    // ④ 計算日期範圍(台灣時間)
    const todayStr = getTaiwanDateStr(0)
    const d3Str    = getTaiwanDateStr(3)

    // ⑤ 查詢出發預警(3天內,任一待辦未完成)— 帶 user_id 供分組
    const { data: depRaw, error: depErr } = await sb
      .from('sales_records')
      .select('user_id, name, tour, date, deposit, balance, preTripNotify, contractUploaded, contractImage')
      .gte('date', todayStr)
      .lte('date', d3Str)
    if (depErr) throw depErr

    const depItems: DepRecord[] = (depRaw ?? []).filter(
      (r: DepRecord) => !r.deposit || !r.balance || !r.preTripNotify || !contractDone(r)
    )

    // ⑥ 查詢開票預警(開票日 3 天內、名單未入、尚未出發)— 帶 user_id 供分組
    const { data: tickRaw, error: tickErr } = await sb
      .from('sales_records')
      .select('user_id, name, tour, date, ticketingDate, list')
      .gte('ticketingDate', todayStr)
      .lte('ticketingDate', d3Str)
      .gte('date', todayStr)
      .eq('list', false)
    if (tickErr) throw tickErr

    const tickItems: TickRecord[] = tickRaw ?? []

    // ⑦ 按使用者分組,各自組訊息、各自推播(一人失敗不影響其他人)
    const lineToken = Deno.env.get('LINE_CHANNEL_TOKEN')!
    const results = await Promise.allSettled(
      recipients.map((rec) => {
        const myDep  = depItems .filter((r) => r.user_id === rec.user_id)
        const myTick = tickItems.filter((r) => r.user_id === rec.user_id)
        const text   = buildMessage(todayStr, myDep, myTick)
        return sendLine(lineToken, rec.line_user_id, text)
      }),
    )

    const failed = results
      .map((r, i) => ({ r, user_id: recipients[i].user_id }))
      .filter(({ r }) => r.status === 'rejected')
    failed.forEach(({ r, user_id }) =>
      console.error(`[line-notify] 推播失敗 user_id=${user_id}:`, (r as PromiseRejectedResult).reason),
    )

    return new Response(
      JSON.stringify({
        success  : failed.length === 0,
        date     : todayStr,
        depCount : depItems.length,
        tickCount: tickItems.length,
        notified : recipients.length - failed.length,
        failed   : failed.length,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  } catch (err) {
    console.error('[line-notify] error:', err)
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }
})
