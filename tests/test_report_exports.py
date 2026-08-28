from app.reports.exporting import export_table


def test_csv_export_writes_formatted_money_as_numeric_text():
    response = export_table(
        "Sales Report",
        ["Subtotal", "GST", "Grand total"],
        [["₹1,20,000.00", "₹21,600.00", "₹1,41,600.00"]],
        "csv",
    )

    assert response.get_data(as_text=True).splitlines()[1] == "120000.00,21600.00,141600.00"
