# Decisions

Cross-cutting decisions. The ledger's own are in its
[brief](docs/requirements/20261023-ledger.md).

## X1 · Amounts in cents

**Decision:** every amount is a whole number of cents, so sums never round.

Reversed by: X2

## X2 · Amounts in minor units

Reverses: X1

**Decision:** every amount is a whole number of the currency's minor unit, as X1 said for
cents.
