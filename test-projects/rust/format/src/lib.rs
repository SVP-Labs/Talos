//! Formatted by hand.

/// Adds one.
#[must_use]
pub fn next(n: u32) -> u32 { n.saturating_add(1) }

/// Adds two.
#[must_use]
pub fn after_next(n: u32) -> u32 {
	next(next(n))
}
