import { isDesignDraft } from '../../design-gallery';
import { hydrateDraft } from '../../design-draft';
import type {
  ComponentCatalogs,
  DatasetIndex,
  DesignDraft,
  ShowcaseMap,
} from '../../drawn-types';
import { ApiError } from './http';
import { setting, type Bindings } from './env';
import {
  DraftValidationError,
  validateDraftAgainstBaseline,
} from '../draft-validation';
export async function asset<T>(env: Bindings, path: string): Promise<T> {
  const base = setting(env, 'APP_BASE_URL') || 'http://localhost:5173';
  const response = env.ASSETS
    ? await env.ASSETS.fetch(new Request(new URL(path, base)))
    : await fetch(new URL(path, base), { redirect: 'error' });
  if (!response.ok)
    throw new ApiError(
      503,
      'dataset_unavailable',
      '설계 데이터를 불러오지 못했습니다.',
    );
  return response.json() as Promise<T>;
}
export async function loadContext(env: Bindings, draft: DesignDraft) {
  const index = await asset<DatasetIndex>(env, '/data/design-index.json');
  const selected = index.designs.find((d) => d.id === draft.baselineId);
  if (!selected)
    throw new ApiError(400, 'unknown_design', '기준 설계를 확인해 주세요.');
  const shard = await asset<Record<string, unknown>>(
    env,
    '/data/design-trees/shard-' +
      String(Math.floor(selected.id / 1000)).padStart(3, '0') +
      '.json',
  );
  const raw = shard[String(selected.id)];
  if (!isDesignDraft(raw))
    throw new ApiError(
      503,
      'dataset_unavailable',
      '원본 설계 형식을 확인할 수 없습니다.',
    );
  return { index, selected, baseline: hydrateDraft(raw) };
}
export async function validatedDraft(
  env: Bindings,
  input: unknown,
): Promise<DesignDraft> {
  if (!isDesignDraft(input))
    throw new ApiError(
      400,
      'invalid_draft',
      '설계 데이터 형식을 확인해 주세요.',
    );
  const [{ baseline }, catalogs] = await Promise.all([
    loadContext(env, input),
    asset<ComponentCatalogs>(env, '/data/component-catalogs.json'),
  ]);
  try {
    return validateDraftAgainstBaseline(input, baseline, catalogs);
  } catch (error) {
    if (error instanceof DraftValidationError)
      throw new ApiError(400, error.code, error.message);
    throw error;
  }
}

export async function showcases(env: Bindings) {
  return asset<ShowcaseMap>(env, '/data/showcase-designs.json');
}
