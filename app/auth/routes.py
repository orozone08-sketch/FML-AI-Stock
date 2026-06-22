from datetime import datetime

from flask import Blueprint, flash, get_flashed_messages, make_response, redirect, render_template, request, url_for
from flask_login import current_user, login_required, login_user, logout_user

from app.extensions import db
from app.core.company_context import clear_active_company, set_active_company_for_user
from app.models import User
from app.services.audit import audit

bp = Blueprint("auth", __name__)


def render_login(message="", category="danger"):
    flashed = get_flashed_messages(with_categories=True)
    if not message and flashed:
        category, message = flashed[0]
    response = make_response(
        render_template(
            "auth/login.html",
            login_message=message or "",
            login_message_category=category or "info",
        )
    )
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


@bp.route("/", methods=["GET"])
def root():
    if current_user.is_authenticated:
        return redirect(url_for("dashboard.index"))
    return redirect(url_for("auth.login"))


@bp.route("/login", methods=["GET", "POST"])
def login():
    if current_user.is_authenticated:
        return redirect(url_for("dashboard.index"))
    if request.method == "POST":
        email = (request.form.get("email") or "").strip().lower()
        password = request.form.get("password") or ""
        user = User.query.filter_by(email=email).first()
        if not user or not user.check_password(password):
            return render_login("Invalid login ID or password.", "danger")
        elif not user.active:
            return render_login("This user is inactive. Ask an administrator to reactivate it.", "danger")
        else:
            clear_active_company()
            company = set_active_company_for_user(user)
            if not company:
                return render_login("Use the FirstTech or Aditya company login.", "danger")
            login_user(user)
            user.last_login_at = datetime.utcnow()
            audit("login", "User", user.id, user.email, user=user)
            db.session.commit()
            next_url = request.args.get("next") or url_for("dashboard.index")
            return redirect(next_url)
    return render_login()


@bp.route("/logout", methods=["POST"])
@login_required
def logout():
    audit("logout", "User", current_user.id, current_user.email)
    db.session.commit()
    logout_user()
    flash("You have been logged out.", "info")
    return redirect(url_for("auth.login"))
