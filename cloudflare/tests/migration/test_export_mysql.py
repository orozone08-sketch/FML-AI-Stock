import decimal, importlib.util, pathlib, tempfile, unittest

PATH = pathlib.Path(__file__).parents[2] / "scripts" / "export-mysql.py"
SPEC = importlib.util.spec_from_file_location("export_mysql", PATH)
MODULE = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(MODULE)

class ExportTests(unittest.TestCase):
    def test_scaled_exact_and_half_up(self):
        self.assertEqual(MODULE.scaled(decimal.Decimal("12.34"), 100), 1234)
        self.assertEqual(MODULE.scaled(decimal.Decimal("1.234"), 1000), 1234)
        with self.assertRaises(ValueError): MODULE.scaled(decimal.Decimal("1.2345"), 1000)

    def test_column_mapping(self):
        self.assertEqual(MODULE.destination_column("total_amount"), ("total_amount_paise", 100))
        self.assertEqual(MODULE.destination_column("quantity"), ("quantity_milliunits", 1000))
        self.assertEqual(MODULE.destination_column("unit_cost"), ("unit_cost_ten_thousandths", 10000))

    def test_output_must_be_outside_repo(self):
        with self.assertRaises(ValueError): MODULE.safe_output(PATH.parent / "unsafe", PATH.parents[2])

    def test_sql_literal_escapes(self):
        self.assertEqual(MODULE.sql_literal("O'Reilly"), "'O''Reilly'")

if __name__ == "__main__": unittest.main()
