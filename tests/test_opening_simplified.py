from app.models import FIFOLayer, InterCompanyTransfer, OpeningStock
from tests.test_fifo_workflows import ids
from tests.test_navigation import login


def test_opening_page_hides_stock_book_and_rate_fields(client):
    login(client)
    response = client.get("/transactions/opening")
    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert "Stock book <select" not in html
    assert "Owner stock book" not in html
    assert "User stock book" not in html
    assert '<span>Rate</span>' not in html
    assert 'name="rate[]"' not in html


def test_opening_stock_saves_without_stock_book_or_rate(client, app):
    with app.app_context():
        data = ids()
        company_id = data["ai"].id
        item_id = data["item"].id

    login(client)
    response = client.post(
        "/transactions/opening/stock",
        data={
            "company_id": company_id,
            "reference_number": "OPEN-NO-RATE",
            "opening_date": "2026-06-22",
            "item_id[]": [item_id],
            "quantity[]": ["5"],
        },
        follow_redirects=True,
    )
    assert response.status_code == 200
    assert b"Opening stock OPEN-NO-RATE saved." in response.data

    with app.app_context():
        opening = OpeningStock.query.filter_by(reference_number="OPEN-NO-RATE").one()
        layer = FIFOLayer.query.filter_by(
            source_type="OPENING_STOCK",
            source_id=opening.id,
        ).one()
        assert opening.stock_book.code == "AI_GST"
        assert layer.unit_cost == 0
        assert layer.available_quantity == 5


def test_opening_pending_stock_saves_without_stock_books_or_rate(client, app):
    with app.app_context():
        data = ids()
        owner_id = data["fml"].id
        user_id = data["ai"].id
        item_id = data["item"].id

    login(client)
    response = client.post(
        "/transactions/opening/pending-stock",
        data={
            "from_company_id": owner_id,
            "to_company_id": user_id,
            "reference_number": "PEND-NO-RATE",
            "transfer_date": "2026-06-22",
            "item_id[]": [item_id],
            "quantity[]": ["3"],
        },
        follow_redirects=True,
    )
    assert response.status_code == 200
    assert b"Opening pending stock PEND-NO-RATE saved." in response.data

    with app.app_context():
        transfer = InterCompanyTransfer.query.filter_by(reference_number="PEND-NO-RATE").one()
        assert transfer.from_stock_book.code == "FML_GST"
        assert transfer.to_stock_book.code == "AI_GST"
        assert transfer.lines[0].fifo_value == 0
