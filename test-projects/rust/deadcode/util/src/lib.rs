//! Helpers nobody calls.

/// Doubles a number.
#[must_use]
pub fn double(n: u32) -> u32 {
    n.saturating_mul(2)
}
