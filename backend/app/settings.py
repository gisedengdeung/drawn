"""One configuration surface for the Python backend; secrets never reach browser props."""
from pathlib import Path
from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[2]
class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(ROOT / ".env.local", ROOT / ".env.backend.local"), extra="ignore", case_sensitive=False, populate_by_name=True)
    database_url: str = ""
    app_base_url: str = "http://localhost:3000"
    session_secret: str = Field(default="", validation_alias=AliasChoices("SESSION_SECRET", "BETTER_AUTH_SECRET"))
    google_client_id: str = ""
    google_client_secret: str = ""
    openai_api_key: str = ""
    agent_openai_model: str = "gpt-5-mini"
    parts_openai_model: str = "gpt-5-mini"
    aliexpress_app_key: str = ""
    aliexpress_app_secret: str = ""
    aliexpress_tracking_id: str = ""
    aliexpress_access_token: str = ""
    aliexpress_ds_enabled: bool = False
    aliexpress_api_protocol: str = "iop"
    aliexpress_top_region: str = "global"
    data_root: Path = ROOT / "public" / "data"
    model_dir: Path = ROOT / "backend" / "model_bundle"
