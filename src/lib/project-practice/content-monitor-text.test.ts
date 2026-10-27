import { describe, expect, it } from 'vitest';
import { stripKnownSourceText } from './content-monitor-text';

describe('table clipboard source matching', () => {
  const rows = [
    ['调查阶段', '记录相同时间段内每百名学生的剩餐重量'],
    ['实施阶段', '保持用餐人数与菜品类别可比并试行小份供应'],
    ['评价阶段', '比较前后的单位人数剩餐重量并记录影响因素'],
  ];
  const table = '| 阶段 | 工作要求 |\n| --- | --- |\n' + rows.map(row => `| ${row.join(' | ')} |`).join('\n');
  it('matches CSV separators and quoted cells against a genuine Markdown table', () => {
    const csv = [['阶段', '工作要求'], ...rows].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');
    expect(stripKnownSourceText(csv, [table])).toBe('');
  });
  it('keeps ordinary code commas and quotes meaningful', () => {
    const code = 'const observations = records.filter(record => record.meal === "lunch");\nconst result = compare(first, second, settings);';
    expect(stripKnownSourceText(code.replace('first, second, settings', 'firstsecondsettings'), [code])).not.toBe('');
  });
  it('exempts long fenced code copies but preserves changed multiplication and comparison operators', () => {
    const code = Array.from({ length: 6 }, (_, index) => `const result${index} = observations${index}.filter(row => row.weight > 20).map(row => row.weight * multiplier);`).join('\n');
    const source = `这是用于检查数据的代码：\n\n\`\`\`javascript\n${code}\n\`\`\``;
    expect(stripKnownSourceText(code, [source])).toBe('');
    const changed = code.replaceAll('weight > 20', 'weight < 20').replaceAll('weight * multiplier', 'weight + multiplier');
    const remainder = stripKnownSourceText(changed, [source]);
    expect(remainder).toContain('< 20');
    expect(remainder).toContain('+ multiplier');
  });
});
