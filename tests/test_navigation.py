def login(client):
    return client.post(
        "/login",
        data={"email": "admin@fastockflow.local", "password": "ChangeMe123!"},
        follow_redirects=True,
    )


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
