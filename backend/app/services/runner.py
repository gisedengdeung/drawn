"""Server-owned agent tools. Every external call is budgeted; proposals never auto-apply."""
import asyncio
import hashlib
import inspect
import json
import re
from uuid import uuid4
from ..core.errors import ApiError
from ..domain.bom import create_bom_snapshot, calculate_offer_amounts
from ..domain.estimate import estimate_draft
from ..domain.optimization import recommend_dataset_candidates, optimize_draft
from ..domain.knowledge import search_knowledge, get_parameter_info
from ..store import iso
from .dataset import load_context, load_design, showcases
from .parts import search_parts
from .llm import AgentModel

def dump(value):
    return json.dumps(value,ensure_ascii=False,separators=(",",":"),allow_nan=False)
def metrics(design):
    return dict(massKg=design.get("mass"),rangeM=design.get("maxDistance"),hoverSeconds=design.get("hoverTime"),powerW=design.get("power"),maxSpeedMps=design.get("maxSpeed"),dragAt20N=design.get("dragAt20"))
def kpis(value, original=False):
    return {key:value.get(source) for key,source in (("mass","mass"),("range","maxDistance" if original else "range"),("hover","hoverTime" if original else "hover"),("power","power"),("maxSpeed","maxSpeed"))}

async def execute_run(ctx):
    store,settings=ctx["store"],ctx["settings"]
    user_id,run_id,project=ctx["user_id"],ctx["run_id"],ctx["project"]
    message,mode=ctx["message"],ctx["mode"]
    evidence=[]; warnings=[]; proposals=[]
    async def check():
        if ctx["cancel_event"].is_set() or await store.is_cancelled(user_id,run_id):
            raise ApiError(409,"cancelled","작업이 취소되었습니다.")
    async def charge(kind):
        await check()
        await store.consume_budget(user_id,run_id,"llm" if kind=="ai" else kind)
    async def tool(label,fn):
        await charge("tool")
        await ctx["emit"](dict(type="progress",runId=run_id,message=label))
        value=await asyncio.to_thread(fn)
        return await value if inspect.isawaitable(value) else value
    def add(kind,title,text,target=None):
        item=dict(id=f"e{len(evidence)+1}",kind=kind,title=title,text=text if isinstance(text,str) else dump(text))
        if target: item["target"]=target
        evidence.append(item)
    context=await tool("원본 설계와 현재 편집 내용을 확인하고 있습니다.",lambda:load_context(settings,project["draft"]))
    index,selected,baseline=context["index"],context["selected"],context["baseline"]
    design_id=selected["id"]
    target=lambda view:dict(view=view,designId=design_id)
    result=dict(answer="",evidence=evidence,proposals=proposals,warnings=warnings,
        context=dict(projectId=project["id"],revision=project["revision"],fingerprint=project["fingerprint"],
            datasetVersion="aircraftverse-"+hashlib.sha256(dump(dict(selected=selected,baseline=baseline)).encode()).hexdigest()[:16]))
    add("dataset-output",f"원본 설계 #{design_id} · 시뮬레이션",metrics(selected),target("explore"))
    estimate=await tool("원본 값과 편집 설계의 추정값을 구분하고 있습니다.",lambda:estimate_draft(selected,project["draft"],baseline,index["designs"]))
    add("dataset-output" if estimate["source"]=="dataset" else "draft-estimate","현재 설계 · "+estimate["modelVersion"],estimate,target("lab"))
    warnings.append("원본 성능은 데이터셋 시뮬레이션이며, 편집 KPI는 인접 설계 추정입니다. 실제 제작·비행 검증이 아닙니다.")

    async def quote_for(draft):
        snapshot=create_bom_snapshot(draft)
        lines=[dict(item=item,result=None,selectedOfferId=None) for item in snapshot["items"]]
        quote=dict(snapshot=snapshot,lines=lines); current=draft is project["draft"]
        if current: result["quote"]=quote
        await charge("tool")
        async def lookup(line):
            try:
                found=await search_parts(line["item"],settings,consume_budget=charge,cancel_event=ctx["cancel_event"],allow_ai=False)
                line["result"]=found
                exact=next((offer for offer in found["offers"] if offer["match"]=="exact" and calculate_offer_amounts(line["item"],offer)["subtotal"] is not None),None)
                line["selectedOfferId"]=exact["id"] if exact else None
            except ApiError as error:
                if error.code=="cancelled": raise
                line["result"]=dict(itemId=line["item"]["id"],status="error",offers=[],warnings=["조회 한도 또는 연결 상태를 확인해 주세요."],retrievedAt=iso())
            except Exception:
                await check()
                line["result"]=dict(itemId=line["item"]["id"],status="error",offers=[],warnings=["조회 한도 또는 연결 상태를 확인해 주세요."],retrievedAt=iso())
        for offset in range(0,len(lines),2):
            await check()
            await ctx["emit"](dict(type="progress",runId=run_id,message=f'설계 #{draft["baselineId"]} 부품 {min(offset+2,len(lines))}/{len(lines)} 조회 중'))
            await asyncio.gather(*(lookup(line) for line in lines[offset:offset+2]))
            if current:
                await store.checkpoint_result(user_id,run_id,{**result,"answer":"부품 조회 중 저장된 결과입니다."})
        return quote

    def quote_evidence(quote,title):
        entries=[]
        for line in quote["lines"]:
            found=line.get("result") or {}
            entries.append(dict(model=line["item"]["model"],quantity=line["item"]["quantity"],status=found.get("status","unavailable"),selectedOfferId=line["selectedOfferId"],
                offers=[{**{k:o.get(k) for k in ("id","productId","title","currency","url","promotionUrl","optionVerified","packQuantity","retrievedAt")},"selected":o["id"]==line["selectedOfferId"],"price":o.get("packPrice"),"priceKind":o.get("priceKind","listing")} for i,o in enumerate(found.get("offers",[])) if i<2 or o["id"]==line["selectedOfferId"]]))
        snap=quote["snapshot"]
        add("supplier-offer",title,dict(designId=snap["designId"],fingerprint=snap["fingerprint"],scope=snap["exclusions"],entries=entries),dict(view="parts",designId=snap["designId"]))

    if mode=="parts":
        quote=await quote_for(project["draft"]); result["quote"]=quote
        quote_evidence(quote,"현재 설계의 AliExpress 조회 결과")
        found=sum(bool((line.get("result") or {}).get("offers")) for line in quote["lines"])
        result["answer"]=f'{len(quote["lines"])}종류 중 {found}종류의 상품 후보를 확인했습니다. 표시가격과 링크는 부품 화면에서 확인할 수 있습니다. 옵션·묶음 수량이 미확인인 상품은 확정 합계에 포함하지 않습니다.'
        statuses={(line.get("result") or {}).get("status") for line in quote["lines"]}
        if "not_configured" in statuses: warnings.append("AliExpress App Key와 App Secret 설정이 필요합니다.")
        if "permission_denied" in statuses: warnings.append("AliExpress 앱의 API 권한을 확인해 주세요.")
        if statuses-{"ok","not_found"}: warnings.append("일부 부품 조회를 완료하지 못했습니다. 완료된 결과는 보존했습니다.")
    else:
        model=AgentModel(settings,lambda:charge("llm"))
        try:
            intent=await model.intent(message)
            if ctx.get("performance"):
                try:
                    prediction=await tool("학습된 모델의 속도별 예측을 확인하고 있습니다.",lambda:ctx["performance"](design_id,project["draft"],[intent["speed"]] if intent["speed"] is not None else [0,10,20,30,40,50]))
                    add("model-prediction","학습 모델 · "+prediction["modelVersion"],prediction,target("simulator"))
                    warnings.extend(prediction.get("warnings",[]))
                except ApiError as error:
                    if error.code=="cancelled": raise
                    add("model-prediction","학습 모델 · 예측 불가",error.message,target("simulator"))
                    warnings.append(error.message)
            if mode=="optimize":
                locks=ctx["locks"]
                options=dict(objective=intent["objective"],massLimit=intent["massLimit"],powerLimit=intent["powerLimit"],topologyLocked=intent["topologyLocked"],lockedParameterIds=locks)
                ranked=await tool("조건에 맞는 데이터셋 후보를 비교하고 있습니다.",lambda:recommend_dataset_candidates(index["designs"],selected,options))
                edited=await tool("잠금을 유지하며 제한된 치수 변경안을 비교하고 있습니다.",lambda:optimize_draft(selected,baseline,project["draft"],index["designs"],**options))
                async def persist(proposal,payload):
                    await check()
                    proposal["id"]=await store.save_proposal(user_id,run_id,project,proposal,payload)
                    proposals.append(proposal)
                for candidate in ranked["candidates"]:
                    reason="원본 시뮬레이션 KPI·"+intent["objective"]+" 목표와 질량/전력 제약으로 선정한 새 기준 설계입니다."
                    proposal=dict(id=str(uuid4()),title=f'기준 설계 #{candidate["id"]} 선택',operation="select_dataset_design",candidateDesignId=candidate["id"],changes=[],metrics=kpis(candidate,True),reason=reason)
                    await persist(proposal,dict(operation=proposal["operation"],candidateDesignId=candidate["id"],locks=[]))
                    add("dataset-output",proposal["title"],dict(candidate=proposal["metrics"],constraints=ranked["constraints"],score=candidate["score"],reason=reason),dict(view="explore",designId=candidate["id"]))
                for candidate in edited["proposals"]:
                    proposal=dict(id=str(uuid4()),title=", ".join(c["label"] for c in candidate["changes"])+" 변경안",operation="patch_draft",
                        changes=[dict(targetId=c["id"],before=c["before"],after=c["after"],unit=c.get("unit")) for c in candidate["changes"]],metrics=kpis(candidate["after"]),
                        reason=f'인접 설계 추정 기준 목표 개선 {candidate["improvement"]*100:.2f}%. '+edited["reason"])
                    await persist(proposal,dict(operation=proposal["operation"],changes=candidate["changes"],locks=locks))
                    add("draft-estimate",proposal["title"],dict(changes=proposal["changes"],before=candidate["before"],after=candidate["after"]),target("lab"))
                warnings.extend(edited["assumptions"])
                if not edited["proposals"]: warnings.append(edited["reason"])
                if intent["compareCost"]:
                    quote=await quote_for(project["draft"]); result["quote"]=quote
                    quote_evidence(quote,"현재 설계 견적")
                    for candidate in ranked["candidates"]:
                        try:
                            draft=await tool("비교 후보의 실제 부품 구성을 확인하고 있습니다.",lambda:load_design(settings,candidate["id"]))
                            quote_evidence(await quote_for(draft),f'후보 #{candidate["id"]} 부품 비교')
                        except ApiError as error:
                            if error.code=="cancelled": raise
                            warnings.append(f'후보 #{candidate["id"]} 비용 비교를 완료하지 못했습니다.')
                    warnings.append("확정 옵션·동일 범위의 가격이 없는 후보는 비용 우위로 평가하지 않았습니다. 상품 표시가격은 확정 구매비가 아닙니다.")
            else:
                bom=await tool("현재 부품 구성과 문서 근거를 확인하고 있습니다.",lambda:create_bom_snapshot(project["draft"]))
                add("user-input","현재 편집 설계의 부품 구성",bom,target("parts"))
                ids=list(dict.fromkeys(int(s) for s in re.findall(r"(?:#\s*|설계\s*#?\s*|\bdesign\s*#?\s*)(\d{1,15})(?!\d)",message,re.I)))
                ids=[i for i in ids if i!=design_id]
                if len(ids)>3: warnings.append("한 질문에서는 현재 설계 외에 먼저 지정한 설계 세 개까지 비교합니다.")
                for other_id in ids[:3]:
                    other=next((d for d in index["designs"] if d["id"]==other_id),None)
                    if other is None:
                        add("dataset-output",f"비교 요청 설계 #{other_id} · 확인 불가","서버 데이터셋에서 해당 설계를 찾을 수 없습니다.")
                        continue
                    current_metrics,other_metrics=metrics(selected),metrics(other)
                    difference={k:other_metrics[k]-current_metrics[k] if isinstance(other_metrics[k],(int,float)) and isinstance(current_metrics[k],(int,float)) else None for k in other_metrics}
                    add("dataset-output",f"비교 설계 #{other_id} · 원본 시뮬레이션",dict(designId=other_id,source="dataset",topology=other.get("hub"),numPropellers=other["numPropellers"],numWings=other["numWings"],**other_metrics,
                        comparison=dict(baselineDesignId=design_id,basis="original-dataset-simulation",baselineMetrics=current_metrics,differenceFromBaseline=difference)),dict(view="explore",designId=other_id))
                    if re.search(r"부품|구성|모터|프로펠러|배터리|서보|\b(?:bom|components?|parts?|motors?|propellers?|batter(?:y|ies)|servos?)\b",message,re.I):
                        try:
                            reference=await tool(f"비교 설계 #{other_id}의 실제 부품 구성을 확인하고 있습니다.",lambda:load_design(settings,other_id))
                            add("dataset-output",f"비교 설계 #{other_id} · 원본 부품 구성",create_bom_snapshot(reference),dict(view="explore",designId=other_id))
                        except ApiError as error:
                            if error.code=="cancelled": raise
                            warnings.append(f"비교 설계 #{other_id} 부품 구성을 확인하지 못했습니다.")
                for parameter in get_parameter_info(project["draft"],message):
                    add("user-input",parameter["label"],parameter,{**target("lab"),"parameterId":parameter["id"]})
                for section in search_knowledge(message):
                    add("document",f'{section["title"]} · {section["path"]} / {section["section"]}',section["text"]+" (문서 "+section["version"]+")")
                if intent["speed"] is not None:
                    data=await tool("해당 설계의 원본 속도별 trim을 확인하고 있습니다.",lambda:showcases(settings))
                    row=next((row for row in data.get(str(design_id),{}).get("trim",[]) if row["speed"]==intent["speed"]),None)
                    add("dataset-trim",f'원본 #{design_id} · {intent["speed"]} m/s',row or "이 설계·속도의 공개 원본 trim이 없습니다. 다른 설계의 곡선으로 대체하지 않습니다.",target("simulator"))
                saved=await tool("이 프로젝트에 저장된 최근 견적을 확인하고 있습니다.",lambda:store.list_quotes(user_id,project["id"]))
                if saved:
                    quote=saved[0]["quote"]
                    quote_evidence(quote,"저장된 현재 견적" if quote["snapshot"]["fingerprint"]==project["fingerprint"] else "저장된 이전 설계 견적")
            try:
                result["answer"]=await model.explain(message,evidence,warnings)
            except ApiError as error:
                if error.code=="cancelled": raise
                result["answer"]=f"{len(proposals)}개의 비교안이 준비되었습니다." if mode=="optimize" else "아래에 현재 설계에서 확인한 근거를 정리했습니다."
                warnings.append("자연어 설명을 완성하지 못해 확인된 계산·조회 결과를 표시합니다.")
            except Exception:
                await check()
                result["answer"]="아래에 현재 설계에서 확인한 계산·조회 결과를 정리했습니다."
                warnings.append("자연어 설명을 완성하지 못해 확인된 계산·조회 결과를 표시합니다.")
        finally:
            await model.close()
    await check()
    result["warnings"]=list(dict.fromkeys(warnings))
    return result
