// 輕量級新聞情緒分析 — 關鍵字字典法（無需 ML，CPU 幾乎為零）
// 對標題 + 摘要做正/負面詞計數，輸出 [-1, +1] 分數
//
// 設計理念：
//   - 情緒是輔助訊號，不是主要決策依據（噪音多）
//   - 樣本不足（< 3 則）不下結論
//   - 同一關鍵字在多篇新聞中算多次（重複出現代表事件強度）

const POS_KEYWORDS = [
  // 業績面
  '營收創高', '營收新高', '營收創新高', '單季新高', 'EPS 創高', 'EPS新高',
  '優於預期', '優預期', '法說會', '展望樂觀', '展望強勁',
  // 訂單面
  '訂單滿手', '訂單能見度', '訂單暢旺', '搶單', '產能滿載', '產能吃緊',
  '受惠', '受惠於', '受益', '挹注',
  // 籌碼面
  '法人買超', '外資買超', '投信買超', '三大法人買超', '法人加碼', '外資加碼',
  '資金回流', '買盤湧現',
  // 技術面
  '突破', '飆漲', '漲停', '創新高', '帶量上攻', '紅 K',
  // 報價面
  '報價上修', '價格上漲', '漲價', '看漲',
  // 市場態度
  '看好', '加碼', '推升', '上修', '看升', '加碼買進', '熱銷', '看俏',
];

const NEG_KEYWORDS = [
  // 業績面
  '營收衰退', '營收年減', '虧損', '虧損擴大', '不如預期', '低於預期',
  '減損', 'EPS 虧損',
  // 訂單面
  '砍單', '訂單下修', '訂單衰退', '消庫存', '庫存調整', '產能利用率下降',
  // 籌碼面
  '法人賣超', '外資賣超', '投信賣超', '三大法人賣超', '法人減碼', '外資減碼',
  '資金外逃', '賣壓沉重',
  // 技術面
  '崩跌', '跌停', '破底', '破前低', '黑K', '殺低', '失守',
  // 報價面
  '報價下修', '價格下跌', '降價', '看跌',
  // 市場態度
  '看淡', '減碼', '下修', '看疲', '黯淡', '疲弱', '降評',
  // 公司治理
  '罰款', '違約', '裁員', '解雇', '減資', '停損', '虧損出場',
];

export function newsSentiment(newsList) {
  if (!Array.isArray(newsList) || !newsList.length) {
    return { score: null, samples: 0, reason: 'no_news' };
  }
  let pos = 0, neg = 0;
  const detectedPos = new Map();
  const detectedNeg = new Map();
  for (const n of newsList) {
    const text = `${n.title || ''} ${n.summary || ''}`;
    if (!text.trim()) continue;
    for (const kw of POS_KEYWORDS) {
      if (text.includes(kw)) {
        pos++;
        detectedPos.set(kw, (detectedPos.get(kw) || 0) + 1);
      }
    }
    for (const kw of NEG_KEYWORDS) {
      if (text.includes(kw)) {
        neg++;
        detectedNeg.set(kw, (detectedNeg.get(kw) || 0) + 1);
      }
    }
  }
  const total = pos + neg;
  const samples = newsList.length;
  if (total < 2) {
    // 太少關鍵字命中，可能是中性新聞或單純價格報導
    return { score: 0, pos, neg, total, samples, label: '中性', reason: 'low_signal' };
  }
  const score = +((pos - neg) / total).toFixed(2);
  const label =
    score >= 0.5 ? '偏多' :
    score >= 0.2 ? '略偏多' :
    score <= -0.5 ? '偏空' :
    score <= -0.2 ? '略偏空' :
    '中性';
  // 取出現次數最高的 3 個關鍵字當代表
  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
  return {
    score,
    pos, neg, total, samples, label,
    topKeywords: { pos: top(detectedPos), neg: top(detectedNeg) },
  };
}
