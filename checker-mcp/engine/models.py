"""Domain models, enums, and skip rules for the matching engine.

Pure data — no I/O, no Paperless calls, no regex execution. Imported by
parsing/matching/collection so they share the same vocabulary.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from enum import Enum, auto


# ── P&L category and skip reasons ────────────────────────────────────────


class PLCategory(Enum):
    EXPENSE = auto()
    EXCLUDED = auto()


class SkipReason(Enum):
    BANK_FEE = auto()
    LOAN_PRINCIPAL = auto()
    LOAN_INTEREST = auto()
    TAX = auto()
    TAX_REFUND = auto()
    INSURANCE = auto()
    PAYROLL = auto()
    DIVIDEND = auto()
    DIVIDEND_TAX = auto()
    PERSONAL_ACCOUNT = auto()
    STATE_TREASURY = auto()


@dataclass
class SkipRule:
    pattern: str
    reason: SkipReason
    pl_category: PLCategory


@dataclass
class SkipResult:
    reason: SkipReason
    pl_category: PLCategory

    @property
    def label(self) -> str:
        return self.reason.name.lower().replace("_", " ")


# Checked against raw_block text. Keywords are case-insensitive, accounts are
# exact. Order matters: first match wins (e.g. dividend rules before personal
# account).
SKIP_RULES = [
    # Bank fees
    SkipRule("Transakčná daň", SkipReason.BANK_FEE, PLCategory.EXPENSE),
    SkipRule("Poplatky za transakcie", SkipReason.BANK_FEE, PLCategory.EXPENSE),
    SkipRule("Poplatok za balík", SkipReason.BANK_FEE, PLCategory.EXPENSE),
    SkipRule("POPLATOK - SPRAVA UVERU", SkipReason.BANK_FEE, PLCategory.EXPENSE),
    # Loan
    SkipRule("SPLATKA ISTINY", SkipReason.LOAN_PRINCIPAL, PLCategory.EXCLUDED),
    SkipRule("SPLATKA UROKU", SkipReason.LOAN_INTEREST, PLCategory.EXPENSE),
    # Dividends (must be before personal account rules)
    SkipRule("podielu na zisku", SkipReason.DIVIDEND, PLCategory.EXCLUDED),
    SkipRule("dan z dividend", SkipReason.DIVIDEND_TAX, PLCategory.EXCLUDED),
    # Taxes
    SkipRule("DPH", SkipReason.TAX, PLCategory.EXCLUDED),
    SkipRule("daň z príjmov", SkipReason.TAX, PLCategory.EXCLUDED),
    SkipRule("dan z prijmov", SkipReason.TAX, PLCategory.EXCLUDED),
    SkipRule("vratka DB DzZČ", SkipReason.TAX_REFUND, PLCategory.EXCLUDED),
    # Insurance
    SkipRule("poistenie", SkipReason.INSURANCE, PLCategory.EXPENSE),
    # Payroll
    SkipRule("mzda", SkipReason.PAYROLL, PLCategory.EXPENSE),
    SkipRule("stravne", SkipReason.PAYROLL, PLCategory.EXPENSE),
]

SKIP_ACCOUNT_RULES = [
    SkipRule(acct.strip(), SkipReason.PAYROLL, PLCategory.EXPENSE)
    for acct in os.environ.get("SKIP_PAYROLL_ACCOUNTS", "").split(",")
    if acct.strip()
] + [
    SkipRule("SPSRSKBA", SkipReason.STATE_TREASURY, PLCategory.EXCLUDED),
]
