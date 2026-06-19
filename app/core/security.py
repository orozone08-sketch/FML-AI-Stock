from functools import wraps

from flask import abort
from flask_login import current_user

from app.core.constants import ROLE_PERMISSIONS


def actions_for(user, module):
    if not user or not user.is_authenticated:
        return set()
    actions = set(ROLE_PERMISSIONS.get(user.role, {}).get(module, set()))
    for override in getattr(user, "permission_overrides", []):
        if override.module != module:
            continue
        for action in ["view", "create", "edit", "approve", "export", "deactivate"]:
            value = getattr(override, "can_" + action)
            if value is True:
                actions.add(action)
            elif value is False:
                actions.discard(action)
    return actions


def can(user, module, action="view"):
    return action in actions_for(user, module)


def require_permission(module, action="view"):
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            if not can(current_user, module, action):
                abort(403)
            return func(*args, **kwargs)

        return wrapper

    return decorator
