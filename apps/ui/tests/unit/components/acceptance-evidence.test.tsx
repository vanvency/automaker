import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  AcceptanceEvidence,
  AcceptanceEvidenceDialog,
} from '../../../src/components/views/board-view/components/acceptance-evidence';
import type { AcceptanceEvidence as Evidence } from '@automaker/types';

vi.mock('@/lib/api-fetch', () => ({
  getAuthenticatedImageUrl: (path: string) => `/api/fs/image?path=${encodeURIComponent(path)}`,
}));
const evidence: Evidence = {
  status: 'passed',
  summary: 'Export verified against the local k3s service',
  verifiedAt: '2026-09-19T07:00:00Z',
  importedAt: '2026-09-19T07:01:00Z',
  previewUrl: 'http://preview.test:31000',
  commit: 'abc123',
  checks: [
    { name: 'Download CSV', status: 'passed', details: '2 rows; current filters applied' },
    { name: 'Read-only role', status: 'skipped', details: 'No restricted account provided' },
  ],
  screenshots: [
    {
      kind: 'prototype',
      path: '/evidence/prototype.png',
      title: 'Audit design',
      capturedAt: '2026-09-19T07:00:00Z',
    },
    {
      kind: 'actual',
      path: '/evidence/actual.png',
      title: 'Audit on k3s',
      capturedAt: '2026-09-19T07:00:00Z',
    },
  ],
};

describe('acceptance evidence on task cards', () => {
  it('shows distinct reference and actual screenshots without claiming human approval', () => {
    render(<AcceptanceEvidence evidence={evidence} projectPath="/project" />);
    expect(screen.getByText('验证通过 · 待人工验收')).toBeInTheDocument();
    expect(screen.getByAltText('原型图：Audit design')).toHaveAttribute(
      'src',
      expect.stringContaining('prototype.png')
    );
    expect(screen.getByAltText('真实截图：Audit on k3s')).toHaveAttribute(
      'src',
      expect.stringContaining('actual.png')
    );
    expect(screen.getByRole('link', { name: '打开验证环境' })).toHaveAttribute(
      'href',
      evidence.previewUrl
    );
  });

  it('opens comparison and lists skipped checks explicitly without editing the card', () => {
    const edit = vi.fn();
    render(
      <div onDoubleClick={edit}>
        <AcceptanceEvidence evidence={evidence} projectPath="/project" />
      </div>
    );
    fireEvent.doubleClick(screen.getByAltText('真实截图：Audit on k3s'));
    expect(edit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '查看验收材料' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('未验证 · Read-only role')).toBeInTheDocument();
    expect(screen.getByText('2 rows; current filters applied')).toBeInTheDocument();
  });

  it('shows blockers without fabricated images or unsafe links', () => {
    render(
      <AcceptanceEvidence
        projectPath="/project"
        evidence={{
          ...evidence,
          status: 'blocked',
          screenshots: [],
          previewUrl: 'javascript:alert(1)',
        }}
      />
    );
    expect(screen.getByText('验证受阻')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('Verify dialog', () => {
  it('enlarges screenshots, switches in both directions and keeps portal clicks off the card', () => {
    const openDetails = vi.fn();
    render(
      <div onClick={openDetails}>
        <AcceptanceEvidenceDialog
          evidence={evidence}
          projectPath="/project"
          open
          onOpenChange={vi.fn()}
        />
      </div>
    );
    fireEvent.click(screen.getByRole('button', { name: '放大原型图：Audit design' }));
    const viewer = screen.getByTestId('evidence-image-viewer');
    expect(viewer.querySelector('img')).toHaveAttribute('alt', '原型图：Audit design');
    fireEvent.click(screen.getByRole('button', { name: '下一张' }));
    expect(viewer.querySelector('img')).toHaveAttribute('alt', '真实截图：Audit on k3s');
    expect(screen.getByText('2 / 2')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowLeft' });
    expect(viewer.querySelector('img')).toHaveAttribute('alt', '原型图：Audit design');
    fireEvent.click(screen.getByRole('button', { name: '上一张' }));
    expect(viewer.querySelector('img')).toHaveAttribute('alt', '真实截图：Audit on k3s');
    fireEvent.click(screen.getByRole('button', { name: '返回验收结果' }));
    expect(screen.queryByTestId('evidence-image-viewer')).not.toBeInTheDocument();
    expect(openDetails).not.toHaveBeenCalled();
  });

  it('confirms human acceptance explicitly even when evidence has blockers, without rewriting it', async () => {
    const onConfirm = vi.fn().mockResolvedValue(true);
    const onOpenChange = vi.fn();
    const blocked = { ...evidence, status: 'blocked' as const };
    render(
      <AcceptanceEvidenceDialog
        evidence={blocked}
        projectPath="/project"
        open
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />
    );
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认 Verify · 移入 Done' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(blocked.status).toBe('blocked');
  });

  it('keeps the result open and permits retry if saving fails', async () => {
    const onConfirm = vi.fn().mockResolvedValue(false);
    const onOpenChange = vi.fn();
    render(
      <AcceptanceEvidenceDialog
        evidence={evidence}
        projectPath="/project"
        open
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />
    );
    fireEvent.click(screen.getByTestId('confirm-verify'));
    expect(await screen.findByRole('alert')).toHaveTextContent('验收状态保存失败');
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('confirm-verify')).toBeEnabled();
  });

  it('keeps the Verify entry usable when no manifest has been supplied', () => {
    render(
      <AcceptanceEvidenceDialog
        projectPath="/project"
        open
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />
    );
    expect(screen.getByText(/此任务尚未提供验收材料/)).toBeInTheDocument();
    expect(screen.getByTestId('confirm-verify')).toBeEnabled();
  });
});
