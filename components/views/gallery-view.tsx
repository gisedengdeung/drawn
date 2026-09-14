'use client';

import { useCallback, useEffect, useState } from 'react';
import { Boxes, Copy, Download, ExternalLink, Search, Share2, Upload } from 'lucide-react';
import { ParametricUavViewer } from '@/components/parametric-uav-viewer';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { galleryPurposes, galleryRequest, isDesignDraft, loadDesignDraft } from '@/lib/design-gallery';
import type { GalleryDetail, GalleryPost, WorkspaceSnapshot } from '@/lib/design-gallery';
import type { DesignDraft, DesignSummary } from '@/lib/aerotwin-types';

const field = 'w-full rounded-lg border border-[#cfdbe2] bg-white px-3 py-2.5 text-sm outline-none focus:border-[#147d91] focus:ring-1 focus:ring-[#147d91]';

export function GalleryView({ current, workspace, initialPostId, onReuse }: {
  current: DesignSummary;
  workspace: WorkspaceSnapshot | null;
  initialPostId: string | null;
  onReuse: (post: GalleryDetail) => void;
}) {
  const [posts, setPosts] = useState<GalleryPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [purpose, setPurpose] = useState('전체');
  const [sort, setSort] = useState('recent');
  const [selectedId, setSelectedId] = useState<string | null>(initialPostId);
  const [detail, setDetail] = useState<GalleryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [detailRetry, setDetailRetry] = useState(0);
  const [publishing, setPublishing] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<DesignDraft | null>(null);
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [description, setDescription] = useState('');
  const [postPurpose, setPostPurpose] = useState<string>(galleryPurposes[0]);
  const [allowReuse, setAllowReuse] = useState(false);
  const [publishError, setPublishError] = useState('');
  const [reusing, setReusing] = useState(false);
  const [reuseConfirm, setReuseConfirm] = useState(false);
  const [shareUrl, setShareUrl] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try { setPosts(await galleryRequest<GalleryPost[]>()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '갤러리를 불러오지 못했습니다.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { let active = true; queueMicrotask(() => { if (active) void refresh(); }); return () => { active = false; }; }, [refresh]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setDetail(null);
      setDetailError('');
      setShareUrl('');
      setDetailLoading(Boolean(selectedId));
    });
    if (!selectedId) return;
    galleryRequest<GalleryDetail>(`?id=${encodeURIComponent(selectedId)}`)
      .then((post) => {
        if (!isDesignDraft(post.draft)) throw new Error('게시물의 설계 데이터를 읽을 수 없습니다.');
        if (active) setDetail(post);
      })
      .catch((reason) => { if (active) setDetailError(reason instanceof Error ? reason.message : '설계를 불러오지 못했습니다.'); })
      .finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; };
  }, [selectedId, detailRetry]);

  const preparePublish = async () => {
    setPreparing(true);
    setPublishError('');
    setNotice('');
    try {
      const draft = workspace?.draft.baselineId === current.id ? structuredClone(workspace.draft) : await loadDesignDraft(current.id);
      setSnapshot(draft);
      setTitle(`${current.id} 나의 드론 설계`);
      setAllowReuse(false);
      setPublishOpen(true);
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : '설계를 준비하지 못했습니다.'); }
    finally { setPreparing(false); }
  };

  const publish = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!snapshot || publishing) return;
    setPublishing(true);
    setPublishError('');
    try {
      const result = await galleryRequest<{ id: string }>('', { method: 'POST', body: JSON.stringify({ title, author, description, purpose: postPurpose, allowReuse, draft: snapshot, parentId: workspace?.draft.baselineId === snapshot.baselineId ? workspace.sourceId : null }) });
      setPublishOpen(false);
      setSelectedId(result.id);
      setQuery(''); setPurpose('전체'); setSort('recent');
      setNotice('갤러리에 게시했어요. 공유 링크를 보내거나 다른 사람이 이 설계를 가져올 수 있습니다.');
      await refresh();
    } catch (reason) { setPublishError(reason instanceof Error ? reason.message : '게시하지 못했습니다.'); }
    finally { setPublishing(false); }
  };

  const reuse = async () => {
    if (!detail || reusing) return;
    setReusing(true);
    try {
      const copy = await galleryRequest<GalleryDetail>('', { method: 'POST', body: JSON.stringify({ action: 'reuse', id: detail.id }) });
      onReuse({ ...copy, draft: structuredClone(copy.draft) });
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : '설계를 가져오지 못했습니다.'); }
    finally { setReusing(false); setReuseConfirm(false); }
  };

  const copyLink = async () => {
    if (!detail) return;
    const url = new URL('/', window.location.origin);
    url.searchParams.set('gallery', detail.id);
    setShareUrl(url.href);
    try { await navigator.clipboard.writeText(url.href); setNotice('공유 링크를 복사했어요. 같은 서버에 접속할 수 있는 사람에게 보내세요.'); }
    catch { setNotice('아래 공유 주소를 선택해서 복사해 주세요.'); }
  };

  const visible = posts.filter((post) => (purpose === '전체' || post.purpose === purpose) && `${post.title} ${post.author} ${post.description}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => sort === 'reuse' ? b.reuses - a.reuses : b.createdAt.localeCompare(a.createdAt));

  return (
    <section className="px-4 py-5 lg:px-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[#c6e0e5] bg-[#eef8fa] p-6">
        <div><p className="text-xs font-semibold text-[#147d91]">6단계 · 공유하고, 함께 발전시키기</p><h1 className="mt-2 text-2xl font-semibold tracking-tight">공유 갤러리</h1><p className="mt-2 text-sm leading-6 text-[#607383]">완성한 3D 설계를 공개하고, 마음에 드는 설계를 내 작업으로 가져오세요.</p></div>
        <Button onClick={preparePublish} disabled={preparing} className="bg-[#147d91] text-white hover:bg-[#0f6475]"><Upload />{preparing ? '설계 준비 중…' : '내 설계 게시하기'}</Button>
      </div>
      <div className="mb-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-[#607383]"><span>공유할 현재 설계 <strong className="text-[#147d91]">#{current.id}</strong> · {workspace?.draft.baselineId === current.id ? '편집 내용 포함' : '선택한 원본 설계'}</span><span>설계·부품·파라미터를 복사하며 원본 게시물은 유지됩니다.</span></div>
      {notice && <p role="alert" className="mb-4 rounded-lg border border-[#c6e0e5] bg-[#eef8fa] p-3 text-sm text-[#0f6475]">{notice}</p>}
      <div className="mb-5 flex flex-wrap gap-3">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-[#cfdbe2] bg-white px-3"><Search className="size-4 shrink-0 text-slate-400" /><span className="sr-only">갤러리 검색</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="설계 이름, 제작자, 설명 검색" className="min-w-0 flex-1 py-2.5 text-sm outline-none" /></label>
        <select aria-label="사용목적 필터" value={purpose} onChange={(event) => setPurpose(event.target.value)} className={`${field} sm:w-44`}><option>전체</option>{galleryPurposes.map((item) => <option key={item}>{item}</option>)}</select>
        <select aria-label="갤러리 정렬" value={sort} onChange={(event) => setSort(event.target.value)} className={`${field} sm:w-44`}><option value="recent">최신순</option><option value="reuse">많이 가져간 순</option></select>
        <Button variant="outline" onClick={refresh} disabled={loading}>새로고침</Button>
      </div>
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(400px,0.9fr)]">
        <div className="min-w-0">
          <output className="mb-3 block text-xs text-slate-500">공개 설계 {visible.length}개 · 최근 100개 게시물</output>
          {error ? <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-6 text-sm text-rose-700">{error}<Button variant="outline" className="mt-3 block" onClick={refresh}>다시 불러오기</Button></div> : loading ? <p className="py-14 text-center text-sm text-slate-500">갤러리를 불러오는 중…</p> : visible.length === 0 ? <div className="rounded-xl border border-dashed border-[#cfdbe2] bg-white p-10 text-center"><Share2 className="mx-auto mb-4 size-8 text-[#147d91]" /><h2 className="font-semibold">{posts.length ? '검색 조건에 맞는 설계가 없어요' : '첫 번째 설계의 주인공이 되어보세요'}</h2><p className="mt-3 text-sm leading-6 text-slate-500">{posts.length ? '검색어나 사용목적을 바꿔보세요.' : '5단계까지 다듬은 설계를 게시하면 다른 사람이 그대로 가져와 이어서 편집할 수 있어요.'}</p>{posts.length > 0 && <Button variant="outline" className="mt-4" onClick={() => { setQuery(''); setPurpose('전체'); }}>필터 초기화</Button>}</div> : <div className="grid gap-3 sm:grid-cols-2">{visible.map((post) => <button type="button" key={post.id} onClick={() => { setSelectedId(post.id); setNotice(''); }} aria-pressed={selectedId === post.id} className={`min-w-0 overflow-hidden rounded-xl border bg-white text-left transition hover:border-[#147d91] ${selectedId === post.id ? 'border-[#147d91] ring-1 ring-[#147d91]' : 'border-[#dbe4ea]'}`}>
            <div className="flex h-24 items-center justify-between bg-[#edf3f6] px-5"><Boxes className="size-9 text-[#6d98a6]" /><div className="text-right text-[11px] leading-5 text-[#607383]"><p>프로펠러 {post.numPropellers}개</p><p>날개 {post.numWings}개</p><p className="font-medium text-[#147d91]">3D 설계 열기 →</p></div></div>
            <div className="p-4"><span className="text-[10px] font-medium text-[#147d91]">{post.purpose}{post.parentId ? ' · 리믹스' : ' · 원본 게시'}</span><h2 className="mt-2 truncate text-sm font-semibold">{post.title}</h2><p className="mt-1 truncate text-xs text-slate-500">by {post.author}</p><p className="mt-3 line-clamp-2 min-h-10 break-words text-xs leading-5 text-slate-500">{post.description}</p><div className="mt-4 flex justify-between gap-2 border-t border-slate-100 pt-3 text-[11px] text-slate-500"><span>{post.createdAt.slice(0, 10)}</span><span>가져오기 {post.reuses}회</span></div></div>
          </button>)}</div>}
        </div>
        <aside className="min-w-0 overflow-hidden rounded-xl border border-[#dbe4ea] bg-white" aria-label="공유 설계 상세">
          {detailLoading ? <p className="p-10 text-center text-sm text-slate-500">3D 설계를 불러오는 중…</p> : detailError ? <div role="alert" className="p-6 text-sm text-rose-700">{detailError}<Button variant="outline" className="mt-3" onClick={() => setDetailRetry((value) => value + 1)}>다시 시도</Button></div> : detail ? <>
            <div className="relative h-72 bg-[#edf3f6] sm:h-80"><ParametricUavViewer key={detail.id} draft={detail.draft} /></div>
            <div className="p-5"><p className="text-xs text-[#147d91]">{detail.purpose} · 기준 설계 #{detail.baselineId}</p><h2 className="mt-2 break-words text-lg font-semibold">{detail.title}</h2><p className="mt-2 text-xs text-slate-500">{detail.author} · {detail.createdAt.slice(0, 10)}</p><p className="mt-4 whitespace-pre-wrap break-words text-sm leading-6 text-slate-600">{detail.description}</p>
              {detail.parentId && <button type="button" onClick={() => setSelectedId(detail.parentId)} className="mt-3 flex items-center gap-1 text-xs text-[#147d91]"><ExternalLink className="size-3" />원본 설계 보기</button>}
              <div className="mt-4 rounded-lg bg-slate-50 p-3 text-xs leading-6 text-slate-500">부품 구성 · 형상 · 파라미터를 게시 시점 그대로 복사합니다.<br />3D 화면은 파라메트릭 미리보기이며 제작용 CAD 파일은 포함하지 않습니다.</div>
              <div className="mt-4 flex flex-wrap gap-2"><Button disabled={reusing} onClick={() => workspace ? setReuseConfirm(true) : void reuse()} className="bg-[#147d91] text-white hover:bg-[#0f6475]"><Download />{reusing ? '가져오는 중…' : '내 작업으로 가져오기'}</Button><Button variant="outline" onClick={copyLink}><Copy />공유 링크</Button></div>
              {shareUrl && <label className="mt-3 block text-xs text-slate-500">공유 주소<input readOnly value={shareUrl} onFocus={(event) => event.target.select()} className={`${field} mt-1 text-xs`} /></label>}
            </div>
          </> : <div className="grid min-h-80 place-items-center p-8 text-center"><div><Boxes className="mx-auto mb-3 size-10 text-slate-300" /><h2 className="text-sm font-medium">공유 설계를 선택해 주세요</h2><p className="mt-2 text-xs leading-6 text-slate-500">3D로 둘러보고, 내 작업에 가져와<br />새로운 설계를 시작할 수 있습니다.</p></div></div>}
        </aside>
      </div>
      <Dialog open={publishOpen} onOpenChange={(open) => { if (!publishing) setPublishOpen(open); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>내 3D 설계 공개하기</DialogTitle><DialogDescription>게시 시점의 설계를 저장합니다. 이후 내 작업을 수정해도 게시물은 바뀌지 않습니다.</DialogDescription></DialogHeader>
          <form onSubmit={publish} className="space-y-4">
            <div className="rounded-lg bg-[#eef8fa] p-3 text-xs text-[#147d91]">설계 #{snapshot?.baselineId} · 프로펠러 {snapshot?.numPropellers}개 · 날개 {snapshot?.numWings}개{workspace?.sourceId && ' · 가져온 설계의 원본 출처가 함께 표시됩니다.'}</div>
            <label className="block text-xs font-medium">설계 이름<input required maxLength={80} value={title} onChange={(event) => setTitle(event.target.value)} className={`${field} mt-1`} /></label>
            <div className="grid gap-4 sm:grid-cols-2"><label className="block text-xs font-medium">제작자 닉네임<input required maxLength={30} value={author} onChange={(event) => setAuthor(event.target.value)} placeholder="갤러리에 표시할 이름" className={`${field} mt-1`} /></label><label className="block text-xs font-medium">사용목적<select value={postPurpose} onChange={(event) => setPostPurpose(event.target.value)} className={`${field} mt-1`}>{galleryPurposes.map((item) => <option key={item}>{item}</option>)}</select></label></div>
            <label className="block text-xs font-medium">설계 소개<textarea required maxLength={1000} rows={4} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="어떤 목적에 맞췄는지, 무엇을 개선했는지 알려주세요." className={`${field} mt-1 resize-y`} /></label>
            <label className="flex items-start gap-2 text-xs leading-5 text-slate-600"><input type="checkbox" required checked={allowReuse} onChange={(event) => setAllowReuse(event.target.checked)} className="mt-1 accent-[#147d91]" />다른 사용자가 이 설계를 복사·수정할 수 있도록 공개합니다.</label>
            {publishError && <p role="alert" className="text-xs text-rose-600">{publishError}</p>}
            <Button type="submit" disabled={publishing || !allowReuse || !title.trim() || !author.trim() || !description.trim()} className="w-full bg-[#147d91] text-white hover:bg-[#0f6475]">{publishing ? '게시 중…' : '갤러리에 게시'}</Button>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={reuseConfirm} onOpenChange={(open) => { if (!reusing) setReuseConfirm(open); }}><DialogContent><DialogHeader><DialogTitle>이 설계로 작업을 시작할까요?</DialogTitle><DialogDescription>현재 편집 중인 설계가 가져온 설계로 바뀝니다. 보관하려면 먼저 현재 설계를 갤러리에 게시해 주세요.</DialogDescription></DialogHeader><div className="flex justify-end gap-2"><Button variant="outline" disabled={reusing} onClick={() => setReuseConfirm(false)}>취소</Button><Button disabled={reusing} onClick={reuse}>{reusing ? '가져오는 중…' : '설계 가져오기'}</Button></div></DialogContent></Dialog>
    </section>
  );
}
