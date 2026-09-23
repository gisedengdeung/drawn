import json
import re
from pathlib import Path
from .draft import hydrate_draft, _COLLATOR

_DATA = json.loads(Path(__file__).with_suffix(".json").read_text("utf-8"))
def normalize(value):
    return "".join(c if c.isalnum() else " " for c in value.lower()).strip()
def search_knowledge(query, limit=3):
    query = normalize(query[:2000])
    if not query:
        return []
    tokens = [t for t in query.split() if len(t)>=2]
    ranked = []
    for section in _DATA["SECTIONS"]:
        score = sum(3 for k in section["keywords"] if normalize(k) in query) + sum(1 for t in tokens if t in normalize(section["title"]+" "+section["text"]))
        if score:
            ranked.append((score,section))
    ranked.sort(key=lambda x:(-x[0],_COLLATOR.sort_key(x[1]["id"])))
    return [s for _,s in ranked[:max(0,min(5,limit))]]
def get_parameter_info(draft, query, limit=8):
    definitions = hydrate_draft(draft)["parameterDefinitions"]
    query = normalize(query[:1000]); tokens = [t for t in query.split() if len(t)>=2]
    aliases = [word for term, words in _DATA["PARAMETER_TERMS"] if term in query for word in words]
    groups = _DATA["GROUP_DESCRIPTIONS"]
    ranked=[]
    for p in definitions:
        searchable=normalize(f'{p["id"]} {p["label"]} {p["group"]} {groups.get(p["group"],"")}')
        score=100 if query in (normalize(p["id"]),normalize(p["label"])) else sum(t in searchable for t in tokens)+3*sum(t in searchable for t in aliases)
        if not query or score>0:
            ranked.append((score,p))
    ranked.sort(key=lambda x:(-x[0],_COLLATOR.sort_key(x[1]["id"])))
    return [dict(source="parameter",**{k:p.get(k) for k in ("id","label","group","path","value","unit","range","editable","affectsGeometry","affectsPerformance")},
        description=groups.get(p["group"],"")+" "+("성능 추정 입력으로 표시되어 있으나 실제 성능 보증은 아닙니다." if p["affectsPerformance"] else "이 파라미터만으로 성능 개선을 주장하지 않습니다.")) for _,p in ranked[:max(0,min(12,limit))]]
