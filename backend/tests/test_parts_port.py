import asyncio
import copy
from datetime import datetime, timezone
import json
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs

import httpx
import pytest

from backend.app.domain.bom import create_bom_snapshot, parse_part_specs, calculate_offer_amounts
from backend.app.services.parts import (
    build_offers, search_parts, sign_parameters, parse_affiliate_products,
    canonical_product_link, affiliate_promotion_link, pack_quantity,
)

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = json.loads((Path(__file__).parent / "fixtures/parts-parity.json").read_text("utf-8"))
ITEM = FIXTURE["offers"][0]["item"]
PRODUCT = FIXTURE["offers"][0]["products"][0]
NOW = lambda: datetime(2026, 9, 21, tzinfo=timezone.utc)


def draft_for(case):
    design_id, name = case["id"], case["name"]
    draft = json.loads((ROOT / f"public/data/design-trees/shard-{design_id // 1000:03d}.json").read_text("utf-8"))[str(design_id)]
    if name == "edited":
        draft["propulsionGroups"][1]["motorType"] = "t_motor_AT4120KV560"
        draft["propulsionGroups"][1]["propellerType"] = "apc_propellers_13x4_5MR"
        draft["energy"]["batteryTypes"][1] = "Tattu15C16000mAh4S1P"
    if name == "duplicate":
        draft["physicalComponents"]["motors"].append(copy.deepcopy(draft["physicalComponents"]["motors"][0]))
        draft["propulsionGroups"].append(copy.deepcopy(draft["propulsionGroups"][0]))
    if name == "conflict":
        draft["propulsionGroups"].append({**draft["propulsionGroups"][0], "motorType": "Other KV450"})
        draft["energy"]["batteryTypes"][0] = ""
    if name == "unlinked":
        draft["physicalComponents"] = dict(motors=[], propellers=[], batteries=[], wings=[], servos=[])
        group = draft["propulsionGroups"][0]
        group.pop("motorInstance", None)
        group.pop("propellerInstance", None)
        draft["propulsionGroups"], draft["wings"] = [group], []
    if name == "servo":
        draft["wings"][1]["servoType"] = "Hitec_HS_65MG"
    return draft


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda x: x["name"])
def test_typescript_bom_parity(case):
    draft = draft_for(case)
    before = copy.deepcopy(draft)
    assert create_bom_snapshot(draft, FIXTURE["now"]) == case["expected"]
    assert draft == before


@pytest.mark.parametrize("case", FIXTURE["specs"], ids=lambda x: x["model"])
def test_typescript_specs_parity(case):
    assert parse_part_specs(case["kind"], case["model"]) == case["expected"]


@pytest.mark.parametrize("case", FIXTURE["offers"])
def test_typescript_offer_verification_parity(case):
    assert build_offers(case["item"], case["products"], case["assessments"], FIXTURE["now"]) == case["expected"]


@pytest.mark.parametrize("case", FIXTURE["pricing"])
def test_typescript_pricing_parity(case):
    assert calculate_offer_amounts(case["item"], case["offer"]) == case["expected"]


def settings(**changes):
    return SimpleNamespace(**dict(dict(aliexpress_app_key="sample", aliexpress_app_secret="test-secret",
        aliexpress_api_protocol="IOP", aliexpress_tracking_id="", aliexpress_access_token="",
        aliexpress_ds_enabled=False, openai_api_key="", parts_openai_model="gpt-5-mini"), **changes))


def affiliate_response(method, rows=None):
    if rows is None:
        rows = [dict(product_id=PRODUCT["productId"], product_title=PRODUCT["title"], product_detail_url=PRODUCT["url"],
                     target_sale_price="12000", target_sale_price_currency="KRW")]
    return {method.replace(".", "_") + "_response": {"resp_result": {"resp_code": 200, "result": {"products": {"product": rows}}}}}


def test_signing_known_vector_and_safe_links():
    assert sign_parameters({"what do ya want for ": "nothing?", "sign": "ignored"}, "Jefe", "md5") == "750C783E6AB0B503EAA86E310A5DB738"
    assert canonical_product_link(PRODUCT["url"] + "?a=1#frag", PRODUCT["productId"]) == PRODUCT["url"]
    assert canonical_product_link("https://aliexpress.com.evil.test/item/1005001234567.html") is None
    assert affiliate_promotion_link("https://s.click.aliexpress.com/e/ABC_123")
    assert affiliate_promotion_link("https://evil.test/e/ABC_123") is None
    assert pack_quantity("2 pairs") == 4
    assert pack_quantity("2 pcs / 4 pcs") is None


def test_search_live_protocol_shape_and_each_retry_is_budgeted():
    async def scenario():
        seen, charged = [], []
        async def charge(kind):
            charged.append(kind)
        def handler(request):
            params = {key: values[0] for key, values in parse_qs(request.content.decode()).items()}
            seen.append(params)
            assert str(request.url) == "https://api-sg.aliexpress.com/sync"
            assert params["sign_method"] == "sha256"
            assert params["sign"] == sign_parameters(params, "test-secret")
            assert "session" not in params
            if len(seen) == 1:
                return httpx.Response(503, json={})
            return httpx.Response(200, json=affiliate_response(params["method"]))
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            result = await search_parts(ITEM, settings(), charge, asyncio.Event(), client=client, now=NOW)
        assert result["status"] == "ok"
        assert charged == ["provider", "provider", "provider"]
        assert [p["method"] for p in seen] == ["aliexpress.affiliate.product.query"] * 2 + ["aliexpress.affiliate.productdetail.get"]
        assert result["offers"][0]["priceKind"] == "listing"
        assert result["offers"][0]["optionVerified"] is False
        assert calculate_offer_amounts(ITEM, result["offers"][0])["subtotal"] is None
    asyncio.run(scenario())


def test_budget_denial_stops_retry_before_network():
    async def scenario():
        calls, charges = [], []
        async def charge(kind):
            charges.append(kind)
            return len(charges) < 2
        def handler(request):
            calls.append(request)
            return httpx.Response(503, json={})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            result = await search_parts(ITEM, settings(), charge, asyncio.Event(), client=client)
        assert result["status"] == "rate_limited" and len(calls) == 1 and len(charges) == 2
    asyncio.run(scenario())


def test_cancellation_never_spends_budget_or_calls_provider():
    async def scenario():
        cancel = asyncio.Event()
        cancel.set()
        async def forbidden(kind):
            pytest.fail("Budget charged after cancellation")
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: pytest.fail("Network after cancellation"))) as client:
            with pytest.raises(asyncio.CancelledError):
                await search_parts(ITEM, settings(), forbidden, cancel, client=client)
    asyncio.run(scenario())


def test_detail_rows_must_still_exist_and_errors_are_sanitized():
    async def scenario():
        def handler(request):
            method = parse_qs(request.content.decode())["method"][0]
            rows = [] if method.endswith("productdetail.get") else None
            return httpx.Response(200, json=affiliate_response(method, rows))
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            result = await search_parts(ITEM, settings(), client=client)
        assert result["status"] == "not_found" and result["offers"] == []
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"error_response": {"code": "29", "msg": "test-secret Invalid AppKey"}}))) as client:
            result = await search_parts(ITEM, settings(), client=client)
        assert result["status"] == "permission_denied" and "test-secret" not in json.dumps(result)
    asyncio.run(scenario())


def test_promotion_links_bind_exact_source_and_ds_stays_opt_in():
    async def scenario():
        methods = []
        def handler(request):
            params = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
            method = params["method"]
            methods.append(method)
            assert "session" not in params
            if method.endswith("link.generate"):
                data = {"promotion_links": {"promotion_link": [
                    {"source_value": "https://www.aliexpress.com/item/99999.html", "promotion_link": "https://s.click.aliexpress.com/e/wrong"},
                    {"source_value": PRODUCT["url"], "promotion_link": "https://s.click.aliexpress.com/e/right"},
                ]}}
                return httpx.Response(200, json={method.replace(".", "_") + "_response": {"resp_result": {"resp_code": 200, "result": data}}})
            return httpx.Response(200, json=affiliate_response(method))
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            result = await search_parts(ITEM, settings(aliexpress_tracking_id="track", aliexpress_access_token="unused"), client=client)
        assert result["offers"][0]["promotionUrl"] == "https://s.click.aliexpress.com/e/right"
        assert not any(".ds." in method for method in methods)
    asyncio.run(scenario())


def test_explicit_ds_uses_authorized_sku_and_confirmed_pack_price():
    async def scenario():
        def handler(request):
            params = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
            method = params['method']
            if method == 'aliexpress.ds.product.get':
                assert params['session'] == 'ds-test-token'
                data = {'ae_item_base_info_dto': {'product_id': PRODUCT['productId'], 'product_status_type': 'onSelling'},
                        'ae_item_sku_info_dtos': {'ae_item_sku_info_d_t_o': [{'sku_id': '980', 'currency_code': 'KRW', 'offer_sale_price': '43000', 'sku_available_stock': 2,
                        'ae_sku_property_dtos': {'ae_sku_property_d_t_o': [{'sku_property_name': 'Model', 'property_value_definition_name': '980KV 4pcs'}]}}]}}
                return httpx.Response(200, json={method.replace('.', '_') + '_response': {'result': data}})
            assert 'session' not in params
            return httpx.Response(200, json=affiliate_response(method))
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            result = await search_parts(ITEM, settings(aliexpress_ds_enabled=True, aliexpress_access_token='ds-test-token'), client=client)
        offer = result['offers'][0]
        assert offer['optionVerified'] and offer['priceKind'] == 'sku' and offer['provider'] == 'aliexpress_ds'
        assert calculate_offer_amounts(ITEM, offer)['subtotal'] == 43000
    asyncio.run(scenario())


def test_optional_ai_calls_charge_ai_budget_and_require_literal_source_evidence():
    async def scenario():
        charges = []
        async def charge(kind):
            charges.append(kind)
        def handler(request):
            if request.url.host == 'api.openai.com':
                body = json.loads(request.content)
                assert body['store'] is False
                if body['text']['format']['name'] == 'part_search_query':
                    answer = {'query': ITEM['model'] + ' brushless motor'}
                else:
                    answer = {'assessments': [{'productId': PRODUCT['productId'], 'relation': 'unrelated', 'evidence': 'not in the actual source'}]}
                return httpx.Response(200, json={'status': 'completed', 'output': [{'content': [{'type': 'output_text', 'text': json.dumps(answer)}]}]})
            method = parse_qs(request.content.decode())['method'][0]
            return httpx.Response(200, json=affiliate_response(method))
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            result = await search_parts(ITEM, settings(openai_api_key='ai-test-key'), charge, client=client, allow_ai=True)
        assert charges == ['ai', 'provider', 'provider', 'ai']
        assert result['status'] == 'ok' and len(result['offers']) == 1
        assert all('not in the actual source' not in reason for reason in result['offers'][0]['reasons'])
    asyncio.run(scenario())


@pytest.mark.parametrize("code", [405, "405"])
def test_affiliate_empty_search_business_response_is_not_found(code):
    async def scenario():
        seen, charged = [], []
        async def charge(kind):
            charged.append(kind)
        def handler(request):
            params = {key: values[0] for key, values in parse_qs(request.content.decode()).items()}
            seen.append(params["method"])
            return httpx.Response(200, json={"aliexpress_affiliate_product_query_response": {
                "resp_result": {"resp_code": code, "resp_msg": "The result is empty"}}})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            result = await search_parts(ITEM, settings(), charge, asyncio.Event(), client=client, now=NOW)
        assert result["status"] == "not_found" and result["offers"] == []
        assert charged == ["provider"]
        assert seen == ["aliexpress.affiliate.product.query"]
    asyncio.run(scenario())


@pytest.mark.parametrize("message", ["Unexpected business error", "Permission denied"])
def test_other_business_405_failures_are_not_treated_as_empty(message):
    async def scenario():
        def handler(request):
            return httpx.Response(200, json={"aliexpress_affiliate_product_query_response": {
                "resp_result": {"resp_code": 405, "resp_msg": message}}})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            result = await search_parts(ITEM, settings(), client=client, now=NOW)
        assert result["status"] == ("permission_denied" if message == "Permission denied" else "error")
    asyncio.run(scenario())
