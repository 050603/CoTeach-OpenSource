// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildClassroomScript, downloadCoursePptx, downloadCourseResources } from './download-course-resources';

const mocks = vi.hoisted(() => ({ saveAs: vi.fn(), buildPptx: vi.fn(), files: new Map<string, unknown>() }));
vi.mock('file-saver', () => ({ default: mocks.saveAs }));
vi.mock('@openmaic/lib/export/image-pptx', () => ({ buildImagePptxBlob: mocks.buildPptx }));
vi.mock('jszip', () => ({ default: class FakeZip {
  constructor(private prefix = '') {}
  folder(name: string) { return new FakeZip(`${this.prefix}${name}/`); }
  file(name: string, value: unknown) { mocks.files.set(`${this.prefix}${name}`, value); }
  async generateAsync() { return new Blob(['archive']); }
} }));

afterEach(() => vi.unstubAllGlobals());

describe('course PPT download', () => {
  const scenes = [{ id: 'page', title: '中文与公式', content: { type: 'slide', canvas: { elements: [] } } }];
  const makePayload = () => ({ schemaVersion: 1, course: { id: 'course', name: '中文/课程' },
    classrooms: [
      { kind: 'teacher', label: '教师授课资源', classroom: { scenes: [] } },
      { kind: 'main', label: '学生 AI 课堂', classroom: { scenes } },
    ], sourceFiles: [{ fileName: '不要下载的资料.pdf', url: '/api/uploads/source' }],
  });
  let payload: ReturnType<typeof makePayload>;
  let fetcher: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks(); mocks.files.clear();
    payload = makePayload();
    mocks.buildPptx.mockResolvedValue(new Blob(['pptx']));
    fetcher = vi.fn(async () => Response.json(payload));
    vi.stubGlobal('fetch', fetcher);
  });

  it('downloads just the main classroom as one PPTX, with no archive, media or source-file downloads', async () => {
    const progress = vi.fn();
    await downloadCoursePptx('课程/id', progress);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/courses/%E8%AF%BE%E7%A8%8B%2Fid/resource-download', { cache: 'no-store' });
    expect(mocks.buildPptx).toHaveBeenCalledExactlyOnceWith(scenes, progress);
    expect(mocks.saveAs).toHaveBeenCalledExactlyOnceWith(expect.any(Blob), '中文_课程.pptx');
    expect(mocks.files.size).toBe(0);
  });

  it('uses a teacher deck when the main classroom has no slides', async () => {
    payload.classrooms[1].classroom.scenes = [];
    payload.classrooms[0].classroom.scenes = scenes;
    await downloadCoursePptx('course');
    expect(mocks.buildPptx).toHaveBeenCalledWith(scenes, undefined);
  });

  it('reports unavailable slides without saving an empty file', async () => {
    payload.classrooms = [];
    await expect(downloadCoursePptx('course')).rejects.toThrow('暂无可导出');
    expect(mocks.saveAs).not.toHaveBeenCalled();
  });

  it('preserves server errors and does not save an export after a failed page render', async () => {
    fetcher.mockResolvedValueOnce(Response.json({ error: '无权访问该课程' }, { status: 403 }));
    await expect(downloadCoursePptx('course')).rejects.toThrow('无权访问该课程');
    mocks.buildPptx.mockRejectedValueOnce(new Error('第 2 页导出失败：图片缺失'));
    await expect(downloadCoursePptx('course')).rejects.toThrow('第 2 页导出失败：图片缺失');
    expect(mocks.saveAs).not.toHaveBeenCalled();
  });

  it('also uses rendered-image PPTX inside the full resource archive', async () => {
    payload.sourceFiles = [];
    // The remaining resources exercise the existing script/JSON path.
    payload.classrooms[1].classroom.scenes = [{ ...scenes[0], actions: [] } as typeof scenes[number]];
    await downloadCourseResources('course');
    expect(mocks.buildPptx).toHaveBeenCalledExactlyOnceWith(payload.classrooms[1].classroom.scenes);
    expect(mocks.files.get('02-学生 AI 课堂/学生 AI 课堂.pptx')).toBeInstanceOf(Blob);
    expect(mocks.files.get('README.txt')).toContain('逐页图片版 PPTX');
    expect(mocks.saveAs).toHaveBeenCalledWith(expect.any(Blob), '中文_课程-完整课程资源.zip');
  });
});

describe('course resource scripts', () => {
  it('exports every scene in order and preserves all speech segments', () => {
    const markdown = buildClassroomScript({
      id: 'classroom-1',
      stage: { id: 'stage-1', name: '课堂', createdAt: 1, updatedAt: 1 },
      createdAt: '2026-09-18T00:00:00.000Z',
      scenes: [
        {
          id: 'scene-1', stageId: 'stage-1', title: '概念导入', type: 'slide', order: 0,
          content: { type: 'slide', canvas: { id: 'canvas-1', viewportSize: 1000, viewportRatio: 0.5625,
            theme: { backgroundColor: '#fff', themeColors: [], fontColor: '#000', fontName: 'Arial' }, elements: [] } },
          actions: [
            { id: 'speech-1', type: 'speech', text: '第一段讲稿。' },
            { id: 'speech-2', type: 'speech', text: '第二段讲稿。' },
          ],
          createdAt: 1, updatedAt: 1,
        },
        {
          id: 'scene-2', stageId: 'stage-1', title: '学生实践', type: 'pbl', order: 1,
          content: { type: 'pbl', projectConfig: {} as never }, actions: [], createdAt: 1, updatedAt: 1,
        },
      ],
    }, '学生 AI 课堂');

    expect(markdown).toContain('# 学生 AI 课堂讲稿');
    expect(markdown).toContain('## 1. 概念导入');
    expect(markdown).toContain('1. 第一段讲稿。\n\n2. 第二段讲稿。');
    expect(markdown).toContain('## 2. 学生实践\n\n（本页无讲稿）');
  });
});
