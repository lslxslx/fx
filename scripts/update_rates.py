#!/usr/bin/env python3
"""Update the nine FX histories from Bank of Albania. Dry-run unless --write."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import tempfile
import time
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from html.parser import HTMLParser
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

SOURCE_URL = "https://www.bankofalbania.org/Tregjet/Kursi_zyrtar_i_kembimit/"
CODES = ("EUR", "USD", "GBP", "CHF", "JPY", "AUD", "CAD", "XAU", "XAG")
MAX_HTML_BYTES = 2 * 1024 * 1024
MAX_AGE_DAYS = 10
DATE_LABEL = re.compile(r"Përdit[ëe]simi\s+i\s+fundit\s*:\s*(\d{2}\.\d{2}\.\d{4})", re.I)


class ValidationError(ValueError):
    """Stop rather than publish incomplete or ambiguous data."""


@dataclass
class Table:
    context: str
    rows: list[list[str]] = field(default_factory=list)


class RatesHTMLParser(HTMLParser):
    """Collect table cells and the visible text immediately preceding each table."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tables: list[Table] = []
        self.context = ""
        self.table: Table | None = None
        self.depth = 0
        self.ignored: str | None = None
        self.row: list[str] | None = None
        self.cell: list[str] | None = None

    def handle_starttag(self, tag, attrs):
        if self.ignored:
            return
        if tag in ("script", "style"):
            self.ignored = tag
            return
        if tag == "table":
            self.depth += 1
            if self.depth == 1:
                self.table = Table(self.context)
                self.context = ""
            return
        if self.depth == 1:
            if tag == "tr":
                self._finish_row()
                self.row = []
            elif tag in ("td", "th"):
                self._finish_cell()
                if self.row is None:
                    self.row = []
                self.cell = []
            elif tag == "br" and self.cell is not None:
                self.cell.append(" ")
        elif self.depth == 0 and tag in ("div", "p", "br", "span"):
            self._context_text(" ")

    def handle_endtag(self, tag):
        if self.ignored:
            if tag == self.ignored:
                self.ignored = None
            return
        if tag == "table" and self.depth:
            if self.depth == 1:
                self._finish_row()
                if self.table is not None:
                    self.tables.append(self.table)
                self.table = None
            self.depth -= 1
        elif self.depth == 1:
            if tag in ("td", "th"):
                self._finish_cell()
            elif tag == "tr":
                self._finish_row()
        elif self.depth == 0 and tag in ("div", "p", "span", "b", "em"):
            self._context_text(" ")

    def handle_data(self, data):
        if self.ignored:
            return
        if self.depth == 0:
            self._context_text(data)
        elif self.depth == 1 and self.cell is not None:
            self.cell.append(data)

    def _context_text(self, text):
        self.context = (self.context + text)[-4000:]

    def _finish_cell(self):
        if self.cell is not None and self.row is not None:
            self.row.append(" ".join("".join(self.cell).split()))
        self.cell = None

    def _finish_row(self):
        self._finish_cell()
        if self.row is not None and self.table is not None:
            self.table.rows.append(self.row)
        self.row = None


def parse_rate(text: str) -> Decimal:
    # Accept explicit decimal formats, never guess what a lone grouping mark means.
    text = text.strip()
    if re.fullmatch(r"\d+(?:\.\d{1,2})?", text):
        normalized = text
    elif re.fullmatch(r"\d{1,3}(?:,\d{3})+\.\d{2}", text):
        normalized = text.replace(",", "")
    elif re.fullmatch(r"\d+,\d{2}", text):
        normalized = text.replace(",", ".")
    else:
        raise ValidationError(f"Unrecognized rate: {text!r}")
    value = Decimal(normalized)
    if not value.is_finite() or value <= 0 or not math.isfinite(float(value)):
        raise ValidationError(f"Rate must be a positive finite number: {text!r}")
    return value


def parse_source(html: str, *, today: date | None = None) -> tuple[date, dict[str, Decimal]]:
    parser = RatesHTMLParser()
    parser.feed(html)
    parser.close()
    candidates = []
    for table in parser.tables:
        found = {cell for row in table.rows for cell in row if cell in CODES}
        if found == set(CODES):
            candidates.append(table)
    if len(candidates) != 1:
        raise ValidationError(f"Expected exactly one complete rates table; found {len(candidates)}")
    table = candidates[0]
    dates = DATE_LABEL.findall(table.context)
    if not dates:
        raise ValidationError("Publication date missing immediately before the rates table")
    try:
        published = datetime.strptime(dates[-1], "%d.%m.%Y").date()
    except ValueError as exc:
        raise ValidationError("Invalid publication date") from exc
    today = today or datetime.now(ZoneInfo("Europe/Tirane")).date()
    if not 0 <= (today - published).days <= MAX_AGE_DAYS:
        raise ValidationError(f"Publication date {published} is future-dated or over {MAX_AGE_DAYS} days old")
    rates: dict[str, Decimal] = {}
    for row in table.rows:
        positions = [i for i, cell in enumerate(row) if cell in CODES]
        if not positions:
            continue
        if len(positions) != 1:
            raise ValidationError("Ambiguous currency row")
        pos = positions[0]
        code = row[pos]
        if code in rates or pos == 0 or pos + 1 >= len(row):
            raise ValidationError(f"Duplicate or incomplete row for {code}")
        label = " ".join(row[:pos])
        if code == "JPY" and not re.search(r"\(\s*100\s*\)", label):
            raise ValidationError("JPY unit changed: expected 100 JPY")
        if code in ("XAU", "XAG") and not re.search(r"\(\s*OZ\s*1\s*\)", label, re.I):
            raise ValidationError(f"{code} unit changed: expected OZ 1")
        rates[code] = parse_rate(row[pos + 1])
    return published, rates


def fetch_source() -> str:
    request = Request(SOURCE_URL, headers={
        "User-Agent": "fx-json-updater/1.0 (+https://github.com/lslxslx/fx)",
        "Accept": "text/html",
        "Cache-Control": "no-cache",
    })
    for attempt in range(3):
        try:
            with urlopen(request, timeout=25) as response:
                final_url = response.geturl()
                if not final_url.startswith("https://www.bankofalbania.org/"):
                    raise ValidationError("Unexpected source redirect")
                if response.headers.get_content_type() != "text/html":
                    raise ValidationError("Expected an HTML response")
                raw = response.read(MAX_HTML_BYTES + 1)
                if len(raw) > MAX_HTML_BYTES:
                    raise ValidationError("Source response is unexpectedly large")
                return raw.decode(response.headers.get_content_charset() or "utf-8")
        except HTTPError as exc:
            # Do not retry access denials, rate limits or missing pages.
            if exc.code not in (500, 502, 503, 504) or attempt == 2:
                raise
        except (URLError, TimeoutError):
            if attempt == 2:
                raise
        time.sleep(attempt + 1)
    raise ValidationError("Source request failed")


def reject_constant(value):
    raise ValidationError(f"Non-finite JSON number: {value}")


def unique_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValidationError(f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def load_history(raw: bytes, code: str) -> list[dict]:
    rows = json.loads(raw.decode("utf-8-sig"), parse_constant=reject_constant,
                      object_pairs_hook=unique_keys)
    if not isinstance(rows, list):
        raise ValidationError(f"{code}: history must be a JSON array")
    dates = set()
    for row in rows:
        if not isinstance(row, dict) or set(row) != {"Data", code}:
            raise ValidationError(f"{code}: expected only Data and {code} fields")
        day = row["Data"]
        if not isinstance(day, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
            raise ValidationError(f"{code}: invalid ISO date {day!r}")
        try:
            date.fromisoformat(day)
        except ValueError as exc:
            raise ValidationError(f"{code}: invalid calendar date {day!r}") from exc
        if day in dates:
            raise ValidationError(f"{code}: duplicate date {day}")
        dates.add(day)
        value = row[code]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
            raise ValidationError(f"{code}: invalid rate on {day}")
    return rows


@dataclass(frozen=True)
class Change:
    path: Path
    before: bytes
    after: bytes


def plan_updates(data_dir: Path, published: date, rates: dict[str, Decimal]) -> list[Change]:
    if set(rates) != set(CODES) or any(not v.is_finite() or v <= 0 for v in rates.values()):
        raise ValidationError("All nine valid rates are required")
    changes = []
    day = published.isoformat()
    for code in CODES:
        path = data_dir / f"{code.lower()}.json"
        if path.is_symlink():
            raise ValidationError(f"Refusing symlink: {path}")
        raw = path.read_bytes()  # Missing files are errors, not permission to discard history.
        rows = load_history(raw, code)
        latest = max((row["Data"] for row in rows), default="")
        if latest > day:
            raise ValidationError(f"{code}: source date {day} is older than local history {latest}")
        existing = next((row for row in rows if row["Data"] == day), None)
        if existing is not None:
            if Decimal(str(existing[code])) != rates[code]:
                raise ValidationError(f"{code}: conflicting rate on {day}; review the correction manually")
            continue
        updated = sorted([*rows, {"Data": day, code: float(rates[code])}],
                         key=lambda row: row["Data"], reverse=True)
        # One record per line makes future commits easy to review.
        encoded = "[\n" + ",\n".join(
            "  " + json.dumps(row, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            for row in updated
        ) + "\n]\n"
        changes.append(Change(path, raw, encoded.encode("utf-8")))
    return changes


def stage_bytes(path: Path, content: bytes) -> Path:
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temp = Path(name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temp, path.stat().st_mode & 0o777)
        return temp
    except BaseException:
        temp.unlink(missing_ok=True)
        raise


def write_changes(changes: list[Change]) -> None:
    # Validate and stage everything before replacing anything. No Git commit is
    # attempted by the workflow if this function fails.
    staged: list[tuple[Change, Path]] = []
    replaced: list[Change] = []
    try:
        for change in changes:
            if change.path.is_symlink() or change.path.read_bytes() != change.before:
                raise ValidationError(f"File changed during update: {change.path}")
            staged.append((change, stage_bytes(change.path, change.after)))
        for change, temp in staged:
            if change.path.is_symlink() or change.path.read_bytes() != change.before:
                raise ValidationError(f"File changed during update: {change.path}")
            os.replace(temp, change.path)
            replaced.append(change)
    except BaseException:
        # Best-effort rollback for ordinary disk errors; not a cross-file transaction
        # against sudden power loss. The Actions runner is disposable on failure.
        for change in reversed(replaced):
            rollback = stage_bytes(change.path, change.before)
            try:
                os.replace(rollback, change.path)
            finally:
                rollback.unlink(missing_ok=True)
        raise
    finally:
        for _, temp in staged:
            temp.unlink(missing_ok=True)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).resolve().parents[1] / "data")
    parser.add_argument("--html", type=Path, help="Read a saved HTML response for offline tests")
    parser.add_argument("--write", action="store_true", help="Write validated updates; default is dry-run")
    args = parser.parse_args(argv)
    try:
        html = args.html.read_text(encoding="utf-8") if args.html else fetch_source()
        published, rates = parse_source(html)
        changes = plan_updates(args.data_dir, published, rates)
        print(f"Source: {SOURCE_URL}\nPublication date: {published}")
        for code in CODES:
            print(f"  {code}: {rates[code]}")
        if args.write:
            write_changes(changes)
        mode = "Updated" if args.write else "Dry-run; would update"
        print(f"{mode}: {len(changes)} file(s)")
        for change in changes:
            print(f"  {change.path.name}")
        if not changes:
            print("Already up to date. No files changed.")
        return 0
    except (ValidationError, OSError, ValueError, OverflowError) as exc:
        print(f"Update aborted: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
