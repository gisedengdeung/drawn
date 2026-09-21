"""Google OIDC with server-side, one-use PKCE state and opaque DB sessions."""
import hashlib
import hmac
import secrets
from urllib.parse import urlencode, urlsplit
from uuid import uuid4
import httpx
from authlib.integrations.httpx_client import AsyncOAuth2Client
from authlib.jose import JsonWebToken
from sqlalchemy import select, insert, update, delete
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from fastapi.responses import JSONResponse, RedirectResponse
from . import database as d
from .store import milliseconds
from .core.errors import ApiError

SESSION_COOKIE = 'drawn.session'
STATE_COOKIE = 'drawn.oauth_state'
SESSION_SECONDS = 7 * 24 * 3600


def missing(settings):
    return [name.upper() for name in ('database_url','app_base_url','session_secret','google_client_id','google_client_secret') if not getattr(settings, name, '')]


def digest(settings, value):
    return hmac.new(settings.session_secret.encode(), value.encode(), hashlib.sha256).hexdigest()


def origin(value):
    parts = urlsplit(value)
    return f'{parts.scheme}://{parts.netloc}'


def same_origin(request):
    supplied = request.headers.get('origin')
    if supplied and supplied != origin(request.app.state.settings.app_base_url):
        raise ApiError(403, 'forbidden', '같은 사이트에서 요청해 주세요.')


def cookie_options(settings):
    return dict(httponly=True, secure=settings.app_base_url.startswith('https://'), samesite='lax', path='/')


async def get_user(request):
    settings = request.app.state.settings
    if missing(settings):
        raise ApiError(503, 'not_configured', 'Google 로그인과 저장소 설정이 필요합니다.')
    token = request.cookies.get(SESSION_COOKIE, '')
    if not token or len(token) > 200:
        return None
    async with request.app.state.session_factory() as s:
        row = (await s.execute(select(d.users).join(d.sessions, d.users.c.id == d.sessions.c.user_id)
            .where(d.sessions.c.token_hash == digest(settings, token), d.sessions.c.expires_at > milliseconds()))).mappings().first()
        return dict(id=row['id'], name=row['name'], email=row['email']) if row else None


async def require_user(request):
    user = await get_user(request)
    if user is None:
        raise ApiError(401, 'unauthorized', 'Google 로그인 후 이용해 주세요.')
    return user


async def rate_limit(request):
    settings = request.app.state.settings
    key = digest(settings, 'oauth:' + (request.client.host if request.client else 'unknown'))
    window = milliseconds() // 60000
    async with request.app.state.session_factory.begin() as s:
        await s.execute(pg_insert(d.auth_limits).values(key=key, window=window, count=0).on_conflict_do_nothing())
        row = (await s.execute(select(d.auth_limits).where(d.auth_limits.c.key == key).with_for_update())).mappings().one()
        count = row['count'] if row['window'] == window else 0
        if count >= 30:
            raise ApiError(429, 'rate_limited', '잠시 후 다시 로그인해 주세요.')
        await s.execute(update(d.auth_limits).where(d.auth_limits.c.key == key).values(window=window, count=count+1))


async def sign_in(request, body):
    settings = request.app.state.settings
    if missing(settings):
        raise ApiError(503, 'not_configured', 'Google 로그인 설정이 필요합니다.')
    same_origin(request)
    callback = body.get('callbackURL', settings.app_base_url)
    if body.get('provider') != 'google' or not isinstance(callback, str):
        raise ApiError(400, 'invalid_input', 'Google 로그인을 선택해 주세요.')
    if origin(callback) != origin(settings.app_base_url) or urlsplit(callback).username or urlsplit(callback).password or '\\' in callback:
        raise ApiError(403, 'forbidden', '허용되지 않은 로그인 반환 주소입니다.')
    await rate_limit(request)
    state = secrets.token_urlsafe(32); browser = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(32); verifier = secrets.token_urlsafe(48)
    async with request.app.state.session_factory.begin() as s:
        await s.execute(delete(d.oauth_states).where(d.oauth_states.c.expires_at <= milliseconds()))
        await s.execute(insert(d.oauth_states).values(state_hash=digest(settings,state), browser_hash=digest(settings,browser),
            nonce=nonce, verifier=verifier, callback_url=callback, expires_at=milliseconds()+600000))
    import base64
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
    url = 'https://accounts.google.com/o/oauth2/v2/auth?' + urlencode(dict(client_id=settings.google_client_id,
        redirect_uri=settings.app_base_url.rstrip('/')+'/api/auth/callback/google', response_type='code', scope='openid email profile',
        state=state, nonce=nonce, code_challenge=challenge, code_challenge_method='S256'))
    response = JSONResponse(dict(url=url, redirect=False), headers={'Cache-Control':'no-store'})
    response.set_cookie(STATE_COOKIE, browser, max_age=600, **cookie_options(settings))
    return response


async def exchange_google(settings, code, verifier, nonce):
    async with AsyncOAuth2Client(settings.google_client_id, settings.google_client_secret,
            redirect_uri=settings.app_base_url.rstrip('/')+'/api/auth/callback/google', timeout=15, follow_redirects=False) as client:
        token = await client.fetch_token('https://oauth2.googleapis.com/token', grant_type='authorization_code', code=code, code_verifier=verifier)
    async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
        response = await client.get('https://www.googleapis.com/oauth2/v3/certs')
        response.raise_for_status()
        keys = response.json()
    return verify_id_token(token['id_token'], keys, settings.google_client_id, nonce)


def verify_id_token(id_token, keys, client_id, nonce):
    claims = JsonWebToken(['RS256']).decode(id_token, keys, claims_options={
        'iss': {'essential':True, 'values':['https://accounts.google.com','accounts.google.com']},
        'aud': {'essential':True, 'value':client_id}, 'exp': {'essential':True}, 'iat': {'essential':True},
        'sub': {'essential':True}, 'nonce': {'essential':True, 'value':nonce}})
    claims.validate(leeway=30)
    if claims.get('azp') not in (None, client_id) or (isinstance(claims.get('aud'),list) and len(claims['aud'])>1 and claims.get('azp')!=client_id):
        raise ValueError('Google authorized party mismatch')
    if claims.get('email_verified') is not True or not isinstance(claims.get('email'), str) or not isinstance(claims.get('sub'), str) or not claims['sub']:
        raise ValueError('Verified Google identity required')
    return dict(claims)


async def callback(request):
    settings = request.app.state.settings
    if missing(settings):
        raise ApiError(503, 'not_configured', 'Google 로그인 설정이 필요합니다.')
    state = request.query_params.get('state', ''); code = request.query_params.get('code', '')
    browser = request.cookies.get(STATE_COOKIE, '')
    if not state or not browser or len(state)>200 or len(browser)>200:
        raise ApiError(400, 'invalid_oauth_state', '로그인 요청이 만료되었습니다. 다시 로그인해 주세요.')
    async with request.app.state.session_factory.begin() as s:
        row = (await s.execute(delete(d.oauth_states).where(d.oauth_states.c.state_hash == digest(settings,state),
            d.oauth_states.c.browser_hash == digest(settings,browser), d.oauth_states.c.expires_at > milliseconds()).returning(d.oauth_states))).mappings().first()
    if row is None or not code or len(code)>4000 or request.query_params.get('error'):
        raise ApiError(400, 'invalid_oauth_state', '로그인을 완료하지 못했습니다. 다시 로그인해 주세요.')
    try:
        identity = await exchange_google(settings, code, row['verifier'], row['nonce'])
    except Exception:
        raise ApiError(502, 'oauth_failed', 'Google 로그인을 확인하지 못했습니다. 다시 시도해 주세요.') from None
    now = milliseconds(); token = secrets.token_urlsafe(32)
    try:
        async with request.app.state.session_factory.begin() as s:
            account = (await s.execute(select(d.accounts).where(d.accounts.c.providerId == 'google', d.accounts.c.accountId == identity['sub']))).mappings().first()
            if account:
                user_id = account['userId']
                exists = (await s.execute(select(d.users.c.id).where(d.users.c.id == user_id))).first()
                if not exists:
                    raise ApiError(409, 'account_conflict', '계정 연결 정보를 확인해 주세요.')
            else:
                # Preserve imported IDs by provider subject; email is never an account-link key.
                existing = (await s.execute(select(d.users.c.id).where(d.users.c.email == identity['email']))).first()
                if existing:
                    raise ApiError(409, 'account_conflict', '기존 계정의 Google 연결 정보를 확인해 주세요.')
                user_id = str(uuid4())
                await s.execute(insert(d.users).values(id=user_id, name=identity.get('name') or identity['email'], email=identity['email'], emailVerified=True,
                    image=identity.get('picture'), createdAt=now, updatedAt=now))
                await s.execute(insert(d.accounts).values(id=str(uuid4()), accountId=identity['sub'], providerId='google', userId=user_id, createdAt=now, updatedAt=now))
            await s.execute(insert(d.sessions).values(token_hash=digest(settings,token), user_id=user_id, expires_at=now+SESSION_SECONDS*1000, created_at=now))
    except IntegrityError:
        raise ApiError(409, 'account_conflict', '계정 연결 중 충돌이 발생했습니다. 다시 로그인해 주세요.') from None
    response = RedirectResponse(row['callback_url'], status_code=303, headers={'Cache-Control':'no-store'})
    response.set_cookie(SESSION_COOKIE, token, max_age=SESSION_SECONDS, **cookie_options(settings))
    response.delete_cookie(STATE_COOKIE, **cookie_options(settings))
    return response


async def sign_out(request):
    same_origin(request)
    token = request.cookies.get(SESSION_COOKIE, '')
    if token:
        async with request.app.state.session_factory.begin() as s:
            await s.execute(delete(d.sessions).where(d.sessions.c.token_hash == digest(request.app.state.settings, token)))
    response = JSONResponse({'success':True}, headers={'Cache-Control':'no-store'})
    response.delete_cookie(SESSION_COOKIE, **cookie_options(request.app.state.settings))
    return response
