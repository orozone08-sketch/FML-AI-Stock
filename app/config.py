import os
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy.pool import StaticPool

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


#hi 

class Config:
    SECRET_KEY = os.getenv("SECRET_KEY", "dev-only-change-me")
    SQLALCHEMY_DATABASE_URI = os.getenv(
        "DATABASE_URL",
        "sqlite:///" + str(BASE_DIR / "instance" / "fastockflow.sqlite"),
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    SQLALCHEMY_ENGINE_OPTIONS = {
        "pool_pre_ping": True,
        "pool_recycle": 280,
    }
    ADMIN_NAME = os.getenv("ADMIN_NAME", "FAstockFlow Admin")
    ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "admin@fastockflow.local")
    _ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "Abhijeet2026")
    ADMIN_PASSWORD = "Abhijeet2026" if _ADMIN_PASSWORD == "ChangeMe123!" else _ADMIN_PASSWORD
    STATIC_ASSET_VERSION = os.getenv("STATIC_ASSET_VERSION", "20260716-1")
    WTF_CSRF_TIME_LIMIT = None


class TestingConfig(Config):
    TESTING = True
    WTF_CSRF_ENABLED = False
    SQLALCHEMY_DATABASE_URI = "sqlite:///:memory:"
    SQLALCHEMY_ENGINE_OPTIONS = {
        "connect_args": {"check_same_thread": False},
        "poolclass": StaticPool,
    }
