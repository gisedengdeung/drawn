"""Read packaged, immutable dataset assets without HTTP or raw dataset access."""
from functools import lru_cache
from pathlib import Path
import copy
import json
from ..core.errors import ApiError
from ..domain.draft import hydrate_draft, validate_draft

@lru_cache(maxsize=40)
def _read(path: str, mtime: int):
    try:
        with open(path, encoding="utf-8") as stream: return json.load(stream)
    except (OSError, ValueError):
        raise ApiError(503, "dataset_unavailable", "설계 데이터를 불러오지 못했습니다.")

def asset(settings, relative):
    root = Path(settings.data_root).resolve()
    path = (root / relative.removeprefix("/data/")).resolve()
    if not path.is_relative_to(root) or not path.is_file(): raise ApiError(503, "dataset_unavailable", "설계 데이터를 불러오지 못했습니다.")
    return _read(str(path), path.stat().st_mtime_ns)

def index(settings): return asset(settings, "design-index.json")
def catalogs(settings): return asset(settings, "component-catalogs.json")
def showcases(settings): return asset(settings, "showcase-designs.json")
def load_design(settings, design_id):
    if isinstance(design_id,bool) or not isinstance(design_id,int) or design_id<1: raise ApiError(400,"unknown_design","기준 설계를 확인해 주세요.")
    shard = asset(settings, f"design-trees/shard-{design_id//1000:03d}.json")
    raw = shard.get(str(design_id))
    if not isinstance(raw,dict): raise ApiError(400,"unknown_design","기준 설계를 확인해 주세요.")
    return hydrate_draft(raw)
def load_context(settings, draft):
    data = index(settings)
    selected = next((d for d in data["designs"] if d["id"] == draft.get("baselineId")), None)
    if selected is None: raise ApiError(400,"unknown_design","기준 설계를 확인해 주세요.")
    return {"index":data, "selected":selected, "baseline":load_design(settings,selected["id"])}
def validated_draft(settings, draft):
    if not isinstance(draft,dict): raise ApiError(400,"invalid_draft","설계 데이터 형식을 확인해 주세요.")
    return validate_draft(draft, load_design(settings,draft.get("baselineId")),catalogs(settings))
