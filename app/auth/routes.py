from datetime import datetime

from flask import Blueprint, flash, get_flashed_messages, make_response, redirect, render_template, request, url_for
from flask_login import current_user, login_required, login_user, logout_user

from app.core.constants import ROLE_ADMIN
from app.core.company_context import (
    clear_active_company,
    company_choices,
    set_active_company_for_user,
    user_can_view_all_companies,
)
from app.extensions import db
from app.models import Company, User
from app.services.audit import audit

bp = Blueprint("auth", __name__)


def login_company_from_id(company_id):
    try:
        company_id = int(company_id or 0)
    except (TypeError, ValueError):
        return None
    if not company_id:
        return None
    return Company.query.filter_by(id=company_id, active=True).first()


def render_login(message="", category="danger", selected_company_id=None, login_id=""):
    flashed = get_flashed_messages(with_categories=True)
    if not message and flashed:
        category, message = flashed[0]
    selected_company = login_company_from_id(selected_company_id)
    if selected_company_id and not selected_company and not message:
        message = "Choose an active company workspace to continue."
        category = "danger"
    response = make_response(
        render_template(
            "auth/login.html",
            login_message=message or "",
            login_message_category=category or "info",
            companies=company_choices(),
            selected_company_id=str(selected_company_id or ""),
            selected_company=selected_company,
            login_id=login_id or "",
        )
    )
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


def render_admin_login(message="", category="danger"):
    response = make_response(
        render_template(
            "auth/admin_login.html",
            login_message=message or "",
            login_message_category=category or "info",
        )
    )
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


def render_register(message="", category="danger"):
    response = make_response(
        render_template(
            "auth/register.html",
            login_message=message or "",
            login_message_category=category or "info",
            companies=company_choices(),
            selected_company=login_company_from_id(request.form.get("company_id") or request.args.get("company_id")),
            form=request.form,
        )
    )
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


def selected_login_company():
    try:
        company_id = int(request.form.get("company_id") or 0)
    except ValueError:
        return None
    if not company_id:
        return None
    return Company.query.filter_by(id=company_id, active=True).first()


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
        remember = bool(request.form.get("remember"))
        selected_company = selected_login_company()
        if not selected_company:
            return render_login("Select FirstTech or Aditya before logging in.", "danger", login_id=email)
        user = User.query.filter_by(email=email).first()
        if not user or not user.check_password(password):
            return render_login(
                "Invalid login ID or password.",
                "danger",
                selected_company_id=selected_company.id,
                login_id=email,
            )
        elif not user.active:
            return render_login(
                "This user is inactive. Ask an administrator to reactivate it.",
                "danger",
                selected_company_id=selected_company.id,
                login_id=email,
            )
        else:
            clear_active_company()
            company = set_active_company_for_user(user)
            if not company:
                return render_login(
                    "Use the owner/admin login for all-company access.",
                    "danger",
                    selected_company_id=selected_company.id,
                    login_id=email,
                )
            if company.id != selected_company.id:
                clear_active_company()
                return render_login(
                    "This login ID does not belong to the selected company.",
                    "danger",
                    selected_company_id=selected_company.id,
                    login_id=email,
                )
            login_user(user, remember=remember)
            user.last_login_at = datetime.utcnow()
            audit("login", "User", user.id, user.email, user=user)
            db.session.commit()
            next_url = request.args.get("next") or url_for("dashboard.index")
            return redirect(next_url)
    return render_login(selected_company_id=request.args.get("company_id"))


@bp.route("/login/company/<int:company_id>", methods=["GET"])
def company_login(company_id):
    if current_user.is_authenticated:
        return redirect(url_for("dashboard.index"))
    return render_login(selected_company_id=company_id)


@bp.route("/register", methods=["GET", "POST"])
def register():
    if current_user.is_authenticated:
        return redirect(url_for("dashboard.index"))
    if request.method == "POST":
        company = selected_login_company()
        name = (request.form.get("name") or "").strip()
        email = (request.form.get("email") or "").strip().lower()
        password = request.form.get("password") or ""
        confirm_password = request.form.get("confirm_password") or ""
        if not company:
            return render_register("Select the company this user belongs to.", "danger")
        if not name or not email:
            return render_register("Name and login ID are required.", "danger")
        if len(password) < 8:
            return render_register("Password must be at least 8 characters.", "danger")
        if password != confirm_password:
            return render_register("Passwords do not match.", "danger")
        if User.query.filter_by(email=email).first():
            return render_register("That login ID is already registered.", "danger")

        user = User(
            name=name,
            email=email,
            company_id=company.id,
            role=ROLE_ADMIN,
            active=True,
        )
        user.set_password(password)
        db.session.add(user)
        db.session.flush()
        audit(
            "register",
            "User",
            user.id,
            user.email,
            after={"company": company.code, "role": user.role},
            user=user,
        )
        db.session.commit()
        flash("Registration complete. Log in with your new ID.", "success")
        return redirect(url_for("auth.login"))
    return render_register()


@bp.route("/admin/login", methods=["GET", "POST"])
def admin_login():
    if current_user.is_authenticated:
        return redirect(url_for("dashboard.index"))
    if request.method == "POST":
        email = (request.form.get("email") or "").strip().lower()
        password = request.form.get("password") or ""
        remember = bool(request.form.get("remember"))
        user = User.query.filter_by(email=email).first()
        if not user or not user.check_password(password) or not user_can_view_all_companies(user):
            return render_admin_login("Invalid admin login ID or password.", "danger")
        if not user.active:
            return render_admin_login("This admin user is inactive.", "danger")
        clear_active_company()
        login_user(user, remember=remember)
        user.last_login_at = datetime.utcnow()
        audit("login", "User", user.id, user.email, user=user)
        db.session.commit()
        return redirect(request.args.get("next") or url_for("dashboard.index"))
    return render_admin_login()


@bp.route("/logout", methods=["POST"])
@login_required
def logout():
    audit("logout", "User", current_user.id, current_user.email)
    db.session.commit()
    logout_user()
    flash("You have been logged out.", "info")
    return redirect(url_for("auth.login"))
