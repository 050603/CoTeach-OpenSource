export type ClassroomAssetStatus = 'running' | 'completed' | 'partial-failure';

export function shouldPollClassroomAssets(status?: ClassroomAssetStatus): boolean {
  return status === 'running';
}
