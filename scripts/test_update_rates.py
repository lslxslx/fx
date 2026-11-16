"""Offline tests: no requests to the Bank and no changes to the real data directory."""

import contextlib
import io
import json
import os
from datetime import date
from decimal import Decimal
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import update_rates as updater

TODAY = date(2026, 11, 16)
PUBLISHED = date(2026, 11, 13)
RATES = dict(zip(updater.CODES, map(Decimal, (
    "90.71", "82.06", "108.52", "98.02", "51.32", "55.74", "57.54", "319655.70", "4101.65"
))))
LABELS = {code: code + " currency" for code in updater.CODES}
LABELS.update(JPY="Jeni Japonez (100)", XAU="Ari(OZ 1)", XAG="Argjend(OZ 1)")


def page(codes=updater.CODES, day="13.11.2026"):
    rows = "".join(
        f"<TR><TD>{LABELS[code]}</TD><TD>{code}</TD><td><b>{RATES[code]}</b></td><td>+0.01</td></TR>"
        for code in codes
    )
    return (
        '<script>const ignored = "Përditesimi i fundit: 31.12.2099";</script>'
        '<div><span>Përditesimi i fundit:</span>&nbsp;'
        f'<span><b>{day}</b>&nbsp;<em><b>12:42:41</b></em></span></div>'
        f'<TABLE><thead><tr><th>Monedha</th><th>Kursi</th></tr></thead>{rows}</TABLE>'
    )


class ParserTests(unittest.TestCase):
    def parse(self, html):
        return updater.parse_source(html, today=TODAY)

    def test_complete_official_table(self):
        self.assertEqual(self.parse(page()), (PUBLISHED, RATES))

    def test_row_order_is_irrelevant(self):
        self.assertEqual(self.parse(page(tuple(reversed(updater.CODES))))[1], RATES)

    def test_unrelated_tables_and_dates_are_ignored(self):
        extra = '<div>Përditesimi i fundit: 15.11.2026</div><table><tr><td>USD</td><td>999</td></tr></table>'
        self.assertEqual(self.parse(extra + page() + extra), (PUBLISHED, RATES))

    def test_duplicate_complete_tables_are_ambiguous(self):
        with self.assertRaises(updater.ValidationError):
            self.parse(page() + page())

    def test_incomplete_table_is_rejected(self):
        with self.assertRaises(updater.ValidationError):
            self.parse(page(updater.CODES[:-1]))

    def test_rates_are_not_combined_across_tables(self):
        with self.assertRaises(updater.ValidationError):
            self.parse(page(updater.CODES[:4]) + page(updater.CODES[4:]))

    def test_duplicate_currency_is_rejected(self):
        with self.assertRaises(updater.ValidationError):
            self.parse(page(updater.CODES + ("EUR",)))

    def test_missing_publication_date(self):
        with self.assertRaises(updater.ValidationError):
            self.parse(page().replace("Përditesimi i fundit:", "Other date:"))

    def test_invalid_future_and_stale_dates(self):
        for day in ("31.11.2026", "17.11.2026", "01.11.2026"):
            with self.subTest(day=day), self.assertRaises(updater.ValidationError):
                self.parse(page(day=day))

    def test_weekend_uses_fridays_publication_date(self):
        self.assertEqual(updater.parse_source(page(), today=date(2026, 11, 15))[0], PUBLISHED)

    def test_source_unit_change_is_rejected(self):
        for old, new in (("(100)", "(1)"), ("OZ 1", "GRAM 1")):
            with self.subTest(old=old), self.assertRaises(updater.ValidationError):
                self.parse(page().replace(old, new))

    def test_invalid_price_does_not_use_delta(self):
        with self.assertRaises(updater.ValidationError):
            self.parse(page().replace("<b>90.71</b>", "<b>--</b>"))

    def test_price_formats(self):
        for text, expected in (("90.71", "90.71"), ("90,71", "90.71"), ("319,655.70", "319655.70"), ("90", "90")):
            with self.subTest(text=text):
                self.assertEqual(updater.parse_rate(text), Decimal(expected))

    def test_ambiguous_and_nonpositive_prices(self):
        for text in ("0", "-2.0", "NaN", "Infinity", "90,710", "1.234,56", "90.710", "", "1e2", "+90.71"):
            with self.subTest(text=text), self.assertRaises(updater.ValidationError):
                updater.parse_rate(text)


class HistoryTests(unittest.TestCase):
    def test_valid_history(self):
        raw = b'[{"Data":"2026-11-12","EUR":90.72}]'
        self.assertEqual(updater.load_history(raw, "EUR"), json.loads(raw))

    def test_empty_explicit_history_is_valid(self):
        self.assertEqual(updater.load_history(b"[]", "EUR"), [])

    def test_bad_shape_and_field_names(self):
        for obj in ({}, [None], [{"date": "2026-11-12", "EUR": 90}], [{"Data": "2026-11-12", "USD": 90}], [{"Data": "2026-11-12", "EUR": 90, "extra": 1}]):
            with self.subTest(obj=obj), self.assertRaises(updater.ValidationError):
                updater.load_history(json.dumps(obj).encode(), "EUR")

    def test_bad_dates(self):
        for day in ("2026-02-30", "2026-1-02", "20261112", "12.11.2026", None):
            with self.subTest(day=day), self.assertRaises(updater.ValidationError):
                updater.load_history(json.dumps([{"Data": day, "EUR": 90}]).encode(), "EUR")

    def test_bad_values(self):
        for value in (True, None, 0, -1, "90.71", float("nan"), float("inf")):
            with self.subTest(value=value), self.assertRaises(updater.ValidationError):
                updater.load_history(json.dumps([{"Data": "2026-11-12", "EUR": value}]).encode(), "EUR")

    def test_duplicate_dates(self):
        row = {"Data": "2026-11-12", "EUR": 90}
        with self.assertRaises(updater.ValidationError):
            updater.load_history(json.dumps([row, row]).encode(), "EUR")

    def test_duplicate_json_keys(self):
        with self.assertRaises(updater.ValidationError):
            updater.load_history(b'[{"Data":"2026-11-12","EUR":90,"EUR":91}]', "EUR")


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name)
        for code in updater.CODES:
            (self.data / f"{code.lower()}.json").write_text(json.dumps([
                {"Data": "2026-11-12", code: float(RATES[code])},
                {"Data": "2026-11-11", code: float(RATES[code]) + 1},
            ]), encoding="utf-8")
        (self.data / "events.json").write_text('[{"id":"keep-me"}]', encoding="utf-8")

    def snapshot(self):
        return {p.name: p.read_bytes() for p in self.data.iterdir() if p.is_file()}

    def plan(self):
        return updater.plan_updates(self.data, PUBLISHED, RATES)

    def test_planning_does_not_modify_files(self):
        before = self.snapshot()
        self.assertEqual(len(self.plan()), 9)
        self.assertEqual(self.snapshot(), before)

    def test_append_preserves_history_sort_and_events(self):
        before = self.snapshot()
        updater.write_changes(self.plan())
        self.assertEqual((self.data / "events.json").read_bytes(), before["events.json"])
        for code in updater.CODES:
            rows = json.loads((self.data / f"{code.lower()}.json").read_bytes())
            self.assertEqual(rows[0], {"Data": "2026-11-13", code: float(RATES[code])})
            self.assertEqual(rows[1:], json.loads(before[f"{code.lower()}.json"]))
        self.assertEqual(set(self.snapshot()), set(before))

    def test_rerun_is_byte_identical_noop(self):
        updater.write_changes(self.plan())
        before = self.snapshot()
        self.assertEqual(self.plan(), [])
        updater.write_changes(self.plan())
        self.assertEqual(self.snapshot(), before)

    def test_conflicting_same_day_rate_blocks_all_updates(self):
        (self.data / "xag.json").write_text('[{"Data":"2026-11-13","XAG":1}]')
        before = self.snapshot()
        with self.assertRaises(updater.ValidationError):
            updater.write_changes(self.plan())
        self.assertEqual(self.snapshot(), before)

    def test_bad_final_currency_blocks_all_updates(self):
        (self.data / "xag.json").write_text("not json")
        before = self.snapshot()
        with self.assertRaises(ValueError):
            updater.write_changes(self.plan())
        self.assertEqual(self.snapshot(), before)

    def test_missing_file_is_not_recreated(self):
        (self.data / "xag.json").unlink()
        before = self.snapshot()
        with self.assertRaises(FileNotFoundError):
            updater.write_changes(self.plan())
        self.assertEqual(self.snapshot(), before)

    def test_older_source_cannot_backfill_or_overwrite(self):
        with self.assertRaises(updater.ValidationError):
            updater.plan_updates(self.data, date(2026, 11, 10), RATES)

    def test_gaps_are_not_filled_with_invented_rates(self):
        updater.write_changes(updater.plan_updates(self.data, date(2026, 11, 16), RATES))
        days = [r["Data"] for r in json.loads((self.data / "eur.json").read_bytes())]
        self.assertEqual(days, ["2026-11-16", "2026-11-12", "2026-11-11"])

    def test_incomplete_rate_set(self):
        with self.assertRaises(updater.ValidationError):
            updater.plan_updates(self.data, PUBLISHED, {"EUR": RATES["EUR"]})

    def test_concurrent_local_edit_is_preserved(self):
        plan = self.plan()
        (self.data / "xag.json").write_text("user edit")
        before = self.snapshot()
        with self.assertRaises(updater.ValidationError):
            updater.write_changes(plan)
        self.assertEqual(self.snapshot(), before)

    def test_replace_error_rolls_back_prior_replacements(self):
        plan = self.plan()
        before = self.snapshot()
        real_replace = os.replace
        counter = 0

        def fail_once(src, dst):
            nonlocal counter
            counter += 1
            if counter == 3:
                raise OSError("simulated disk error")
            return real_replace(src, dst)

        with patch.object(updater.os, "replace", side_effect=fail_once):
            with self.assertRaises(OSError):
                updater.write_changes(plan)
        self.assertEqual(self.snapshot(), before)

    def test_cli_defaults_to_dry_run(self):
        before = self.snapshot()
        with patch.object(updater, "fetch_source", return_value=page()), \
             patch.object(updater, "parse_source", return_value=(PUBLISHED, RATES)), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(updater.main(["--data-dir", str(self.data)]), 0)
        self.assertIn("Dry-run", output.getvalue())
        self.assertEqual(self.snapshot(), before)

    def test_cli_failed_fetch_never_creates_today_values(self):
        before = self.snapshot()
        with patch.object(updater, "fetch_source", side_effect=OSError("offline")), \
             contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(updater.main(["--data-dir", str(self.data), "--write"]), 1)
        self.assertEqual(self.snapshot(), before)

    def test_symlink_is_rejected(self):
        eur = self.data / "eur.json"
        eur.unlink()
        eur.symlink_to(self.data / "usd.json")
        with self.assertRaises(updater.ValidationError):
            self.plan()


class FetchTests(unittest.TestCase):
    def test_access_denial_is_not_retried(self):
        error = HTTPError(updater.SOURCE_URL, 403, "Forbidden", {}, None)
        with patch.object(updater, "urlopen", side_effect=error) as fetch:
            with self.assertRaises(HTTPError):
                updater.fetch_source()
        self.assertEqual(fetch.call_count, 1)

    def test_transient_server_error_retries_are_bounded(self):
        error = HTTPError(updater.SOURCE_URL, 503, "Unavailable", {}, None)
        with patch.object(updater, "urlopen", side_effect=error) as fetch, patch.object(updater.time, "sleep"):
            with self.assertRaises(HTTPError):
                updater.fetch_source()
        self.assertEqual(fetch.call_count, 3)


if __name__ == "__main__":
    unittest.main()
