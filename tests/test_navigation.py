from app.core.company_context import ACTIVE_COMPANY_SESSION_KEY
from app.models import Company, Customer


def choose_company(client, code="AI"):
    with client.application.app_context():
        company = Company.query.filter_by(code=code).one()
        company_id = company.id
    with client.session_transaction() as session:
        session[ACTIVE_COMPANY_SESSION_KEY] = company_id


def login(client, login_id="adityainternational.user", password="Aditya2026", company_code=None):
    selected_code = company_code
    if not selected_code:
        selected_code = "FML" if login_id == "firsttech.user" else "AI"
    with client.application.app_context():
        company = Company.query.filter_by(code=selected_code).one()
    response = client.post(
        "/login",
        data={"company_id": company.id, "email": login_id, "password": password},
        follow_redirects=True,
    )
    if company_code:
        choose_company(client, company_code)
    return response


def test_company_login_selects_aditya_context(client):
    response = login(client)
    assert response.status_code == 200
    assert b"Aditya International" in response.data
    assert b'body class="theme-aditya"' in response.data
    assert b"Jewellery factory supplies stock control" in response.data
    assert b"aditya-logo.jpg" in response.data
    assert b"Choose Company" not in response.data


def test_payments_page_has_type_search_for_customer_and_supplier(client):
    login(client)
    response = client.get("/finance/payments")
    html = response.get_data(as_text=True)

    assert response.status_code == 200
    assert 'name="customer_search"' in html
    assert 'placeholder="Type customer name or code"' in html
    assert 'name="supplier_search"' in html
    assert 'placeholder="Type supplier name or code"' in html
    assert "data-option-picker" in html


def test_company_login_selects_firsttech_context(client):
    response = login(client, "firsttech.user", "Firsttech2026")
    assert response.status_code == 200
    assert b"FirstTech Machine LLP" in response.data
    assert b'body class="theme-firsttech"' in response.data
    assert b"Next generation technology stock control" in response.data
    assert b"firsttech-logo.jpg" in response.data
    assert b"Choose Company" not in response.data


def test_fixed_company_login_cannot_switch_company(client):
    login(client, "firsttech.user", "Firsttech2026")
    with client.application.app_context():
        aditya = Company.query.filter_by(code="AI").one()
    response = client.post(
        "/company/select",
        data={"company_id": aditya.id, "next": "/dashboard/"},
        follow_redirects=True,
    )
    assert response.status_code == 200
    assert b"FirstTech Machine LLP" in response.data
    assert b"Aditya International</button>" not in response.data


def test_admin_login_is_not_a_fastockflow_login(client):
    response = login(client, "admin@fastockflow.local", "Abhijeet2026")
    assert response.status_code == 200
    assert b"Use the owner/admin login for all-company access." in response.data
    assert b"Company Login" in response.data
    assert b"FirstTech Machine LLP" in response.data
    assert b"Aditya International" in response.data


def test_company_login_shows_invalid_password_message(client):
    response = login(client, "adityainternational.user", "wrong-password")
    assert response.status_code == 200
    assert b"Invalid login ID or password." in response.data


def test_owner_admin_login_opens_combined_dashboard(client):
    response = client.post(
        "/admin/login",
        data={"email": "admin@fastockflow.local", "password": "Abhijeet2026"},
        follow_redirects=True,
    )
    assert response.status_code == 200
    assert b"All Companies" in response.data
    assert b"Combined FirstTech and Aditya control" in response.data
    assert b"Choose Company" not in response.data


def test_owner_admin_login_shows_invalid_password_message(client):
    response = client.post(
        "/admin/login",
        data={"email": "admin@fastockflow.local", "password": "wrong-password"},
        follow_redirects=True,
    )
    assert response.status_code == 200
    assert b"Invalid admin login ID or password." in response.data


def test_login_page_has_direct_company_options(client):
    response = client.get("/login")
    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert 'name="company_id" type="radio"' in html
    assert 'name="email" type="text"' in html
    assert "firsttech-logo.jpg" in html
    assert "aditya-logo.jpg" in html
    assert "FAstockFlow" in html
    assert "Secure company workspace for FirstTech and Aditya users." in html
    assert "Register user" in html


def test_company_login_rejects_wrong_company_selection(client, app):
    with app.app_context():
        firsttech_id = Company.query.filter_by(code="FML").one().id
    response = client.post(
        "/login",
        data={
            "company_id": firsttech_id,
            "email": "adityainternational.user",
            "password": "Aditya2026",
        },
        follow_redirects=True,
    )

    assert response.status_code == 200
    assert b"This login ID does not belong to the selected company." in response.data


def test_company_registration_creates_company_scoped_login(client, app):
    with app.app_context():
        aditya_id = Company.query.filter_by(code="AI").one().id

    response = client.post(
        "/register",
        data={
            "company_id": aditya_id,
            "name": "Paras Aditya",
            "email": "paras.aditya",
            "password": "AdityaStaff2026",
            "confirm_password": "AdityaStaff2026",
        },
        follow_redirects=True,
    )
    assert response.status_code == 200
    assert b"Registration complete. Log in with your new ID." in response.data

    response = client.post(
        "/login",
        data={"company_id": aditya_id, "email": "paras.aditya", "password": "AdityaStaff2026"},
        follow_redirects=True,
    )

    assert response.status_code == 200
    assert b"Paras Aditya" in response.data
    assert b"Aditya International" in response.data
    assert b"All Companies" not in response.data


def test_logged_entries_show_registered_user_name(client, app):
    with app.app_context():
        aditya_id = Company.query.filter_by(code="AI").one().id
        customer_id = Customer.query.filter_by(active=True).first().id

    client.post(
        "/register",
        data={
            "company_id": aditya_id,
            "name": "Entry Operator",
            "email": "entry.operator",
            "password": "EntryPass2026",
            "confirm_password": "EntryPass2026",
        },
        follow_redirects=True,
    )
    client.post(
        "/login",
        data={"company_id": aditya_id, "email": "entry.operator", "password": "EntryPass2026"},
        follow_redirects=True,
    )
    response = client.post(
        "/transactions/opening/receivable",
        data={
            "company_id": aditya_id,
            "customer_id": customer_id,
            "sale_type": "GST",
            "reference_number": "OPEN-USER-1",
            "pending_amount": "1250",
        },
        follow_redirects=True,
    )

    assert response.status_code == 200
    assert b"Created By" in response.data
    assert b"Entry Operator" in response.data

    report = client.get("/reports/opening-summary")
    assert report.status_code == 200
    assert b"Created by" in report.data
    assert b"Entry Operator" in report.data


def test_item_lines_keep_dropdown_and_add_typing_search(client):
    login(client)

    response = client.get("/transactions/opening")
    html = response.get_data(as_text=True)

    assert response.status_code == 200
    assert 'data-item-search' in html
    assert 'data-item-value' in html
    assert 'name="item_id[]"' in html
    assert 'data-item-open' in html
    assert "Select or type item" in html


def test_master_sidebar_marks_only_current_menu_active(client):
    login(client)
    response = client.get("/masters/items")
    assert response.status_code == 200
    html = response.get_data(as_text=True)
    nav_html = html.split('<nav class="nav">', 1)[1].split("</nav>", 1)[0]
    assert nav_html.count('class="active"') == 1
    assert 'class="active">Items</a>' in nav_html
    assert 'class="active">Customers</a>' not in nav_html
    assert 'class="active">Suppliers</a>' not in nav_html


def test_sidebar_company_names_switch_company_context(client):
    login(client)
    response = client.get("/transactions/opening")
    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert 'action="/company/select"' in html
    assert 'Aditya International</button>' in html
    assert 'FirstTech Machine LLP</button>' not in html


def test_topbar_omits_background_music_controls(client):
    login(client)
    response = client.get("/dashboard/")
    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert 'data-music-toggle' not in html
    assert 'data-music-volume' not in html
    assert 'aria-label="Background music volume"' not in html
    assert 'aria-label="Due alerts"' in html


def test_missing_page_renders_when_company_context_is_absent(client):
    login(client)
    with client.session_transaction() as session:
        session.pop(ACTIVE_COMPANY_SESSION_KEY, None)

    response = client.get("/missing-page")

    assert response.status_code == 404
    assert b"Not found" in response.data
    assert b"fastockflow-icon.png" in response.data
