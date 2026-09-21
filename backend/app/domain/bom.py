"""Physical-instance BOM and conservative quote arithmetic."""
from datetime import datetime, timezone
import math
import re

from .draft import fingerprint, stable_hash

MISSING = "실제 부품 인스턴스를 확인할 수 없어 수량을 확정하지 않았습니다."


def norm(value):
    return value.strip() if isinstance(value, str) else ""


def parse_part_specs(kind, model):
    specs = {}
    if kind == "motor":
        suffix = list(re.finditer(r"(?<![\d.,])(\d+(?:\.\d+)?)[\s_]*KV(?![a-z0-9])", model, re.I))
        positions = {match.start() + match.group().upper().rfind("KV") for match in suffix}
        prefix = [match for match in re.finditer(r"KV[\s_:=-]*(\d+(?:\.\d+)?)(?![\d.,a-z])", model, re.I) if match.start() not in positions]
        ratings = {float(match[1]) for match in prefix + suffix}
        ranges = r"(?:KV[\s_:=-]*\d+(?:\.\d+)?\s*(?:[-~/,–—]|\bto\b)\s*\d+(?:\.\d+)?\b|\d+(?:\.\d+)?\s*(?:[-~/,–—]|\bto\b)\s*\d+(?:\.\d+)?\s*KV)"
        if len(ratings) == 1 and not re.search(ranges, model, re.I):
            value = next(iter(ratings))
            if math.isfinite(value) and value > 0:
                specs["motorKv"] = value
    if kind == "propeller":
        match = re.search(r"(\d+(?:[._]\d+)?)\s*[x×]\s*(\d+(?:[._]\d+)?)", model, re.I)
        if match:
            specs.update(diameterIn=float(match[1].replace("_", ".")), pitchIn=float(match[2].replace("_", ".")))
    if kind == "battery":
        for key, pattern in (
            ("capacityMah", r"(\d+(?:\.\d+)?)\s*mAh"),
            ("cells", r"(\d+)\s*S(?=\d|P|\b|[_-])"),
            ("dischargeC", r"(\d+(?:\.\d+)?)\s*C(?=\d|\b|Square|[_-])"),
            ("voltage", r"(\d+(?:[._]\d+)?)\s*V\b"),
        ):
            match = re.search(pattern, model, re.I | re.ASCII)
            if match and float(match[1].replace("_", ".")) > 0:
                specs[key] = float(match[1].replace("_", "."))
    return specs


def create_bom_snapshot(draft, now=None):
    items, exclusions = [], ["기체 제작물과 설계에 기록되지 않은 부품은 견적에 포함되지 않습니다."]
    physicals = draft.get("physicalComponents", {})
    for kind, source in (("motor", "motors"), ("propeller", "propellers"), ("battery", "batteries"), ("servo", "servos")):
        physical = physicals.get(source, [])
        overlays, unlinked = {}, []

        def overlay(instance, model):
            overlays.setdefault(instance, set()).add(norm(model))

        def uncertain(model, message=MISSING):
            unlinked.append(dict(instance=None, model=norm(model), uncertain=True, issues=[message]))

        if kind in ("motor", "propeller"):
            for group in draft.get("propulsionGroups", []):
                instance, model = norm(group.get(kind + "Instance")), norm(group.get(kind + "Type"))
                if instance and any(component.get("instance") == instance for component in physical):
                    overlay(instance, model)
                elif model:
                    uncertain(model)
        if kind == "battery":
            for index, model in enumerate(draft.get("energy", {}).get("batteryTypes", [])):
                instance = norm(physical[index].get("instance")) if index < len(physical) else ""
                if instance:
                    overlay(instance, model)
                elif norm(model):
                    uncertain(model)
        if kind == "servo":
            for wing in draft.get("wings", []):
                if "servoType" not in wing:
                    continue
                wing_index = next((i for i, part in enumerate(physicals.get("wings", [])) if wing.get("path") == "physical." + part.get("instance", "")), -1)
                instance = norm(physical[wing_index].get("instance")) if 0 <= wing_index < len(physical) else ""
                if instance:
                    overlay(instance, wing["servoType"])
                elif not any(norm(part.get("choice")) == norm(wing["servoType"]) for part in physical):
                    uncertain(wing["servoType"], "날개와 실제 서보의 연결을 확인할 수 없습니다.")
        records, missing = {}, []
        for component in physical:
            instance = norm(component.get("instance"))
            edits = overlays.get(instance, set())
            conflict = len(edits) > 1
            model = next(iter(edits)) if len(edits) == 1 else norm(component.get("choice"))
            record = dict(instance=instance or None, model=model, uncertain=not instance or conflict,
                          issues=["동일 인스턴스에 서로 다른 모델 변경이 연결되어 있습니다."] if conflict else [])
            if not instance:
                record["issues"].append(MISSING)
                missing.append(record)
            elif instance not in records:
                records[instance] = record
            elif records[instance]["model"] != model:
                records[instance]["uncertain"] = True
                records[instance]["issues"].append("중복 인스턴스의 원본 모델 정보가 서로 다릅니다.")
        records = list(records.values()) + missing + unlinked
        if kind == "servo" and physical and unlinked:
            for record in records:
                record["uncertain"] = True
                record["issues"].append("연결되지 않은 서보 변경이 있어 기존 모델의 수량도 확인이 필요합니다.")
        grouped = {}
        for record in records:
            model = record["model"]
            item = grouped.setdefault(model, dict(id=kind + ":" + stable_hash(model), kind=kind, model=model,
                quantity=0, instances=[], specs=parse_part_specs(kind, model), issues=[]))
            if record["instance"] and record["instance"] not in item["instances"]:
                item["instances"].append(record["instance"])
            item["quantity"] = None if record["uncertain"] or item["quantity"] is None else item["quantity"] + 1
            item["issues"].extend(record["issues"])
            if not model:
                item["issues"].append("부품 모델명이 없어 검색할 수 없습니다.")
            if not item["specs"]:
                item["issues"].append("모델명에서 확인 가능한 규격이 없어 상품 규격을 별도로 확인해야 합니다.")
            item["issues"] = list(dict.fromkeys(item["issues"]))
        items.extend(grouped.values())
    if not physicals.get("motors") or not physicals.get("propellers"):
        exclusions.append("추진계 실제 부품 목록이 부족합니다. 대칭 개수나 도면 템플릿으로 수량을 추정하지 않았습니다.")
    created = now or datetime.now(timezone.utc)
    if isinstance(created, datetime):
        created = created.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return dict(fingerprint=fingerprint(draft), designId=draft["baselineId"], createdAt=created, items=items, exclusions=exclusions)


def calculate_offer_amounts(item, offer):
    unknown = dict(packCount=None, unitPrice=None, subtotal=None, shipping=None)
    def positive_int(value):
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0 < value <= 2**53 - 1 and int(value) == value
    def money(value):
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0
    conflict = any(key in offer.get("specs", {}) and abs(value - offer["specs"][key]) > .00001 for key, value in item["specs"].items())
    if (not positive_int(item.get("quantity")) or not positive_int(offer.get("packQuantity"))
        or offer.get("priceKind") == "listing" or not offer.get("optionVerified")
        or not money(offer.get("packPrice")) or offer["packPrice"] <= 0 or offer.get("currency") != "KRW"
        or offer.get("shippingAvailable") is False or conflict):
        return unknown
    packs = math.ceil(item["quantity"] / offer["packQuantity"])
    stock = offer.get("stock")
    if stock is not None and (not positive_int(stock) or stock < packs):
        return unknown
    subtotal = math.floor(packs * offer["packPrice"] * 100 + .5) / 100
    if not math.isfinite(subtotal) or subtotal > 2**53 - 1:
        return unknown
    shipping = offer.get("shippingCost") if offer.get("shippingAvailable") is True and offer.get("shippingCurrency") == "KRW" and money(offer.get("shippingCost")) else None
    return dict(packCount=packs, unitPrice=offer["packPrice"] / offer["packQuantity"], subtotal=subtotal, shipping=shipping)
