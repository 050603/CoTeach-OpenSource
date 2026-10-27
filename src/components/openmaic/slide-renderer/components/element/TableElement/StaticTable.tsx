'use client';

import type { CSSProperties } from 'react';
import type { PPTTableElement, TableCell } from '@openmaic/dsl';
import { getTableSubThemeColor } from '@openmaic/lib/utils/element';
import { getTextStyle, formatText, tableCellLayout } from './tableUtils';

/** Project the DSL grid into native HTML cells. Grid placement is shared with
 * the editor so compact rows and legacy covered-cell placeholders agree. */
export function StaticTable({ elementInfo: table }: { elementInfo: PPTTableElement }) {
  const rows = tableCellLayout(table.data, table.colWidths.length);
  const palette = table.theme ? getTableSubThemeColor(table.theme.color) : [];
  const themedRows = new Set<number>();
  const themedColumns = new Set<number>();
  if (table.theme?.rowHeader) themedRows.add(0);
  if (table.theme?.rowFooter) themedRows.add(rows.length - 1);
  if (table.theme?.colHeader) themedColumns.add(0);
  if (table.theme?.colFooter) themedColumns.add(table.colWidths.length - 1);
  const border: CSSProperties = table.outline ? {
    borderWidth: table.outline.width ?? 1,
    borderColor: table.outline.color ?? '#000',
    borderStyle: table.outline.style === 'dashed' ? 'dashed' : 'solid',
  } : { border: 'none' };

  const appearance = (cell: TableCell, row: number, column: number): CSSProperties => {
    const stripe = (row - Number(Boolean(table.theme?.rowHeader))) % 2 === 0;
    const rowAccent = themedRows.has(row);
    const fill = rowAccent ? table.theme?.color
      : themedColumns.has(column) ? palette[0] : stripe ? palette[1] : undefined;
    return {
      ...border, padding: '1px 5px', verticalAlign: 'middle', wordBreak: 'break-word',
      backgroundColor: fill, color: rowAccent ? '#fff' : undefined,
      ...getTextStyle(cell.style),
    };
  };

  return <table className="w-full h-full" style={{ tableLayout: 'fixed', borderCollapse: 'collapse' }}>
    <colgroup>{table.colWidths.map((fraction, index) =>
      <col key={index} style={{ width: `${fraction * table.width}px` }} />)}</colgroup>
    <tbody>{rows.map((cells, row) =>
      <tr key={row} data-slide-row-index={row} style={{ height: `${table.cellMinHeight}px` }}>
        {cells.map(({ cell, columnIndex }) => <td key={cell.id}
          data-cell-id={cell.id} data-slide-cell-id={cell.id}
          rowSpan={cell.rowspan > 1 ? cell.rowspan : undefined}
          colSpan={cell.colspan > 1 ? cell.colspan : undefined}
          style={appearance(cell, row, columnIndex)}
          dangerouslySetInnerHTML={{ __html: formatText(cell.text) }} />)}
      </tr>)}</tbody>
  </table>;
}
