import { describe, it, expect } from 'vitest';
import { csvCell, csvRow } from '../src/csv.js';
import { formatCombinedEvalLines } from '../src/cli/eval-cmd.js';
import type { EvalResult } from '../src/eval/types.js';

/**
 * A minimal RFC 4180 reader, written here on purpose: the bead's requirement is
 * that the emitted file *parses back* into the same cells, so the test must check
 * the format rather than reuse the writer's own logic (agent-do-wcz).
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else if (ch === '\n' || ch === '\r') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

describe('CSV writing is RFC 4180 quoted (agent-do-wcz)', () => {
  it('quotes only when the format requires it', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('')).toBe('');
    expect(csvCell(0)).toBe('0');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell('a\nb')).toBe('"a\nb"');
    // The case both duplicated copies missed: a lone CR is a row terminator to
    // most readers, and `\r\n` only looked safe because it also contains `\n`.
    expect(csvCell('a\rb')).toBe('"a\rb"');
    expect(csvCell('a\r\nb')).toBe('"a\r\nb"');
  });

  it('joins cells without inventing delimiters', () => {
    expect(csvRow(['a', 1, 'b'])).toBe('a,1,b');
    expect(csvRow([])).toBe('');
  });

  it('round-trips hostile cells through an RFC 4180 reader', () => {
    const cells = [
      'plain',
      'with,comma',
      'with"quote',
      'with\nnewline',
      'with\rCR',
      'with\r\nboth',
      '',
    ];
    expect(parseCsv(csvRow(cells))).toEqual([cells]);
  });

  it('a lone CR or a comma in a cell neither forges nor shifts rows', () => {
    const rows = parseCsv(csvRow(['a\rb', 'c,d', 'e']));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(['a\rb', 'c,d', 'e']);
  });

  it('a multi-row document keeps exactly one row per record', () => {
    const doc = [csvRow(['suite', 'case']), csvRow(['s,b', 'c\n1']), csvRow(['ok', 'plain'])].join(
      '\n',
    );
    expect(parseCsv(doc)).toEqual([
      ['suite', 'case'],
      ['s,b', 'c\n1'],
      ['ok', 'plain'],
    ]);
  });
});

describe('the eval command emits the shared CSV format (agent-do-wcz)', () => {
  it('one row per case, hostile values intact, columns in place', () => {
    // Model-produced text reaches the suite name, case name and error column.
    const result = {
      name: 'suite,one',
      timestamp: '2026-10-18T00:00:00.000Z',
      providers: [
        {
          provider: 'anthropic',
          model: 'm',
          cases: [
            { name: 'case\r1', passed: true, cost: 0.000123, durationMs: 5, steps: 2, error: 'a\nb' },
            { name: 'plain', passed: false, cost: 0, durationMs: 1, steps: 1, error: undefined },
          ],
        },
      ],
    } as unknown as EvalResult;

    const rows = parseCsv(formatCombinedEvalLines([result]).join('\n'));
    expect(rows).toHaveLength(3); // header + 2 cases
    expect(rows[0]).toHaveLength(10);
    expect(rows[1]).toEqual([
      '2026-10-18T00:00:00.000Z',
      'suite,one',
      'anthropic',
      'm',
      'case\r1',
      'true',
      '0.000123',
      '5',
      '2',
      'a\nb',
    ]);
    expect(rows[2][4]).toBe('plain');
    expect(rows[2][5]).toBe('false');
    expect(rows[2][9]).toBe('');
  });
});
