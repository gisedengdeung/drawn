# 이전 TypeScript 구현

현재 서비스의 업무 처리는 [Python 구현](../../../backend/app/services/parts.py)으로 이동했습니다. `app/api`는 FastAPI로 요청을 전달하며 이 디렉터리를 실행하지 않습니다.

기존 TypeScript 파일은 이식 결과 대조와 회귀 테스트의 기준으로 보존했습니다. 새 기능·수정은 `backend/app`에 적용하고, 프런트 요청·응답 계약과 Python 테스트를 함께 확인하세요.

실행·이전 방법: [FASTAPI_MIGRATION.md](../../../docs/FASTAPI_MIGRATION.md).
