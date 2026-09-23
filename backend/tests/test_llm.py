from types import SimpleNamespace
import httpx
import pytest
from openai import RateLimitError
from backend.app.services.llm import AgentModel, Intent, Answer
from backend.app.core.errors import ApiError

@pytest.mark.asyncio
async def test_quota_failure_is_charged_once_and_redacted(monkeypatch):
    calls=[]
    async def charge(): calls.append("llm")
    async def parse(**kwargs):
        assert kwargs["store"] is False and kwargs["max_output_tokens"]==1800
        assert kwargs["text_format"] is Intent
        raise RateLimitError("sensitive upstream detail",response=httpx.Response(429,request=httpx.Request("POST","https://api.openai.com/v1/responses")),body={"error":{"code":"credit_balance_exhausted"}})
    model=AgentModel(SimpleNamespace(openai_api_key="synthetic-test",agent_openai_model="gpt-5-mini",parts_openai_model=""),charge)
    monkeypatch.setattr(model.client.responses,"parse",parse)
    try:
        with pytest.raises(ApiError) as error:
            await model.intent("Explain at 20m/s")
        assert error.value.status==429 and error.value.code=="model_quota"
        assert "sensitive" not in error.value.message
        assert calls==["llm"]
    finally: await model.close()

@pytest.mark.asyncio
@pytest.mark.parametrize("answer,ids,valid",[
    ("근거를 확인했습니다. [e1]",["e1"],True),
    ("질량은 5 kg입니다. [e1]",["e1"],False),
    ("근거를 확인했습니다. [e9]",["e9"],False),
    ("근거를 확인했습니다.",["e1"],False),
])
async def test_explanation_requires_existing_citations_and_no_invented_values(answer,ids,valid):
    model=object.__new__(AgentModel)
    async def structured(schema,instructions,data):
        assert schema is Answer
        return Answer(answer=answer,evidenceIds=ids)
    model.structured=structured
    result=await model.explain("Question",[dict(id="e1")],[])
    assert (result==answer) is valid
