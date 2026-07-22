from slowapi import Limiter
from slowapi.util import get_remote_address

# Shared limiter instance: imported by main.py to register the app-wide handler,
# and by routers that need to throttle brute-force-prone endpoints (login, etc).
limiter = Limiter(key_func=get_remote_address)
