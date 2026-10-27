import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContentMonitorEvent } from '@/lib/project-practice/content-monitor-contract';
import { DocumentContentReminder } from './document-content-reminder';

const event: ContentMonitorEvent = {
  id: 'event', studentId: 'student', studentName: '学生', createdAt: '', pastedCharacters: 400,
  excerpt: '我们比较了两个方案并选择第二种。', requirementQuote: '比较方案并形成自己的结论。',
  reason: '粘贴片段包含任务要求的完整比较与结论。', status: 'pending', contentState: 'unchanged', history: [],
};
afterEach(cleanup);
describe('document content reminder', () => {
  it('allows immediate dismissal without requiring a source explanation', () => {
    const dismiss = vi.fn(), explain = vi.fn();
    render(<DocumentContentReminder event={event} onDismiss={dismiss} onExplain={explain} />);
    expect(screen.getByText(/不代表认定违规/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '保存说明并继续' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
    expect(dismiss).toHaveBeenCalledOnce(); expect(explain).not.toHaveBeenCalled();
  });
  it('retains optional explanation after a failed save while keeping editing available', async () => {
    const explain = vi.fn().mockRejectedValue(new Error('来源说明暂未保存，请重试。'));
    const dismiss = vi.fn();
    render(<DocumentContentReminder event={event} onDismiss={dismiss} onExplain={explain} />);
    fireEvent.change(screen.getByLabelText('来源说明（可选）'), { target: { value: 'template' } });
    fireEvent.change(screen.getByLabelText('补充说明（可选）'), { target: { value: '模板中的示例，尚未改写。' } });
    fireEvent.click(screen.getByRole('button', { name: '保存说明并继续' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('暂未保存'));
    expect(explain).toHaveBeenCalledWith('template', '模板中的示例，尚未改写。');
    expect((screen.getByLabelText('补充说明（可选）') as HTMLTextAreaElement).value).toBe('模板中的示例，尚未改写。');
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' })); expect(dismiss).toHaveBeenCalledOnce();
  });
});
