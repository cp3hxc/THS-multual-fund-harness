'use strict';

function parseHoldingsRecognition(raw) {
  let source = String(raw || '').trim();
  const fenced = source.match(/```(?:fund-holdings-import|json)?\s*([\s\S]*?)```/i);
  if (fenced) source = fenced[1].trim();
  else if (source[0] !== '{' && source[0] !== '[') {
    const start = source.search(/[\[{]/);
    if (start >= 0) {
      const stack = [];
      let quoted = false;
      let escaped = false;
      for (let index = start; index < source.length; index++) {
        const char = source[index];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') quoted = false;
          continue;
        }
        if (char === '"') { quoted = true; continue; }
        if (char === '{') stack.push('}');
        else if (char === '[') stack.push(']');
        else if (char === '}' || char === ']') {
          if (stack.pop() !== char) break;
          if (!stack.length) { source = source.slice(start, index + 1); break; }
        }
      }
    }
  }
  let parsed;
  try { parsed = JSON.parse(source); } catch { throw new Error('AI 返回格式无法读取，请重新识别或手动录入。'); }
  const rows = Array.isArray(parsed) ? parsed : [parsed?.funds, parsed?.holdings, parsed?.positions, parsed?.items, parsed?.data?.funds].find(Array.isArray);
  if (!Array.isArray(rows)) throw new Error('AI 没有返回持仓清单，请重新识别或手动录入。');
  const numeric = value => {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) < 1e12 ? value : null;
    const cleaned = String(value).replace(/[¥￥,，\s元]/g, '');
    if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(cleaned)) return null;
    const number = Number(cleaned);
    return Number.isFinite(number) && Math.abs(number) < 1e12 ? number : null;
  };
  const field = (row, ...keys) => keys.map(key => row?.[key]).find(value => value !== undefined && value !== null && value !== '');
  return rows.slice(0, 300).map(row => {
    const codeValue = String(field(row, 'fundCode', 'code', '基金代码') || '').trim();
    return {
      fundName: String(field(row, 'fundName', 'name', '基金名称') || '').trim().slice(0, 120),
      fundCode: /^\d{6}$/.test(codeValue) ? codeValue : '',
      amount: numeric(field(row, 'amount', 'marketValue', 'holdingAmount', '持有金额', '持有市值')),
      holdingIncome: numeric(field(row, 'holdingIncome', 'profit', 'holdingProfit', '持有收益', '持仓收益', '浮动盈亏')),
      dailyIncome: numeric(field(row, 'dailyIncome', 'todayProfit', 'dayIncome', '日收益', '当日收益'))
    };
  }).filter(row => row.fundName || row.fundCode);
}

module.exports = { parseHoldingsRecognition };
