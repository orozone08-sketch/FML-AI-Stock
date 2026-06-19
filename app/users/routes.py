from flask import Blueprint, flash, redirect, render_template, request, url_for
from flask_login import current_user, login_required

from app.core.constants import MODULES, ROLES, ROLE_ADMIN
from app.core.security import require_permission
from app.extensions import db
from app.models import PermissionOverride, User
from app.services.audit import audit

bp = Blueprint("users", __name__, url_prefix="/users")


@bp.route("/")
@login_required
@require_permission("users", "view")
def index():
    users = User.query.order_by(User.active.desc(), User.name).all()
    return render_template("users/index.html", users=users, roles=ROLES)


@bp.route("/new", methods=["GET", "POST"])
@login_required
@require_permission("users", "create")
def create():
    user = User(active=True, role="VIEWER")
    if request.method == "POST":
        try:
            apply_user_form(user, require_password=True)
            user.created_by_id = current_user.id
            db.session.add(user)
            db.session.flush()
            audit("create", "User", user.id, user.email, after={"role": user.role}, user=current_user)
            db.session.commit()
            flash("User created.", "success")
            return redirect(url_for("users.index"))
        except Exception as exc:
            db.session.rollback()
            flash(str(exc), "danger")
    return render_template("users/form.html", user=user, roles=ROLES, modules=MODULES, override_map={})


@bp.route("/<int:user_id>/edit", methods=["GET", "POST"])
@login_required
@require_permission("users", "edit")
def edit(user_id):
    user = db.session.get(User, user_id)
    if not user:
        flash("User not found.", "danger")
        return redirect(url_for("users.index"))
    if request.method == "POST":
        try:
            before = {"email": user.email, "role": user.role, "active": user.active}
            apply_user_form(user, require_password=False)
            protect_last_admin(user)
            user.updated_by_id = current_user.id
            audit("edit", "User", user.id, user.email, before=before, after={"role": user.role, "active": user.active}, user=current_user)
            db.session.commit()
            flash("User updated.", "success")
            return redirect(url_for("users.index"))
        except Exception as exc:
            db.session.rollback()
            flash(str(exc), "danger")
    return render_template("users/form.html", user=user, roles=ROLES, modules=MODULES, override_map=build_override_map(user))


@bp.route("/<int:user_id>/deactivate", methods=["POST"])
@login_required
@require_permission("users", "deactivate")
def deactivate(user_id):
    user = db.session.get(User, user_id)
    if not user:
        flash("User not found.", "danger")
        return redirect(url_for("users.index"))
    try:
        user.active = False
        protect_last_admin(user)
        audit("deactivate", "User", user.id, user.email, user=current_user)
        db.session.commit()
        flash("User deactivated.", "success")
    except Exception as exc:
        db.session.rollback()
        flash(str(exc), "danger")
    return redirect(url_for("users.index"))


def apply_user_form(user, require_password):
    user.name = request.form["name"].strip()
    user.email = request.form["email"].strip().lower()
    user.role = request.form.get("role") or "VIEWER"
    user.active = bool(request.form.get("active"))
    user.force_password_change = bool(request.form.get("force_password_change"))
    password = request.form.get("password") or ""
    if require_password and not password:
        raise ValueError("Temporary password is required.")
    if password:
        user.set_password(password)
    if not user.name or not user.email:
        raise ValueError("Name and email are required.")
    if user.role not in ROLES:
        raise ValueError("Invalid role.")

    # Store only explicit per-user overrides. Blank means inherit role template.
    user.permission_overrides = []
    for module in MODULES:
        values = {}
        touched = False
        for action in ["view", "create", "edit", "approve", "export", "deactivate"]:
            raw = request.form.get(f"perm__{module}__{action}", "")
            if raw == "allow":
                values["can_" + action] = True
                touched = True
            elif raw == "deny":
                values["can_" + action] = False
                touched = True
            else:
                values["can_" + action] = None
        if touched:
            user.permission_overrides.append(PermissionOverride(module=module, **values))


def protect_last_admin(user):
    if user.role == ROLE_ADMIN and user.active:
        return
    active_admins = User.query.filter(
        User.id != user.id,
        User.role == ROLE_ADMIN,
        User.active.is_(True),
    ).count()
    if active_admins == 0:
        raise ValueError("Cannot deactivate or demote the last active administrator.")


def build_override_map(user):
    values = {}
    for override in user.permission_overrides:
        module_values = {}
        for action in ["view", "create", "edit", "approve", "export", "deactivate"]:
            raw = getattr(override, "can_" + action)
            module_values[action] = "allow" if raw is True else "deny" if raw is False else ""
        values[override.module] = module_values
    return values
