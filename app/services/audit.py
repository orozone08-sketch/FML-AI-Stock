import json

from flask import has_request_context, request
from flask_login import current_user

from app.extensions import db
from app.models import AuditLog


def _json(value):
    if value is None:
        return None
    return json.dumps(value, default=str, sort_keys=True)


def audit(action, entity_type, entity_id=None, reference=None, before=None, after=None, approval_reason=None, user=None):
    actor = user
    if actor is None and has_request_context() and current_user.is_authenticated:
        actor = current_user
    log = AuditLog(
        user_id=getattr(actor, "id", None),
        action=action,
        entity_type=entity_type,
        entity_id=str(entity_id) if entity_id is not None else None,
        reference=reference,
        before_values=_json(before),
        after_values=_json(after),
        approval_reason=approval_reason,
        ip_address=request.remote_addr if has_request_context() else None,
        user_agent=(request.user_agent.string[:255] if has_request_context() else None),
    )
    db.session.add(log)
    return log
